// ---- Optional Memcached (disabled by default in local dev)
const MEMCACHED_ENDPOINT = process.env.MEMCACHED_ENDPOINT; // e.g. 'n11713739-cache.km2jzi.0001.apse2.cache.amazonaws.com:11211'
let cache = {
  async get(_k) {
    return null;
  }, // no-op by default
  async set(_k, _v, _ttl) {
    /* no-op */
  }, // no-op by default
};

if (MEMCACHED_ENDPOINT) {
  try {
    const Memcached = require("memcached");
    const mc = new Memcached(MEMCACHED_ENDPOINT, {
      timeout: 1000, // fail fast
      retries: 0,
      retriesDelay: 0,
      failures: 0,
    });
    cache.get = (key) =>
      new Promise((resolve) => {
        mc.get(key, (err, data) => resolve(err ? null : data));
      });
    cache.set = (key, value, ttl) =>
      new Promise((resolve) => {
        mc.set(key, value, ttl, () => resolve()); // swallow errors
      });
    console.log("[cache] Memcached enabled:", MEMCACHED_ENDPOINT);
  } catch (e) {
    console.warn(
      "[cache] Failed to init Memcached, using no-op cache:",
      e?.message || e
    );
  }
} else {
  console.log("[cache] Memcached disabled (no MEMCACHED_ENDPOINT set)");
}

const fs = require("fs");
const path = require("path");

// === AWS SDK (SQS + DynamoDB for job queue/status) ===
const { SQSClient, SendMessageCommand } = require("@aws-sdk/client-sqs");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
} = require("@aws-sdk/lib-dynamodb");

// Use Node's stdlib for IDs (avoids ESM nanoid issue)
const { randomUUID } = require("crypto");

// ENV for jobs
const AWS_REGION = process.env.AWS_REGION || "ap-southeast-2";
const QUEUE_URL = process.env.QUEUE_URL; // e.g. https://sqs.ap-southeast-2.amazonaws.com/<acct>/TranscoderJobs
const JOBS_TABLE =
  process.env.JOBS_TABLE || process.env.TABLE_NAME || "transcoder-jobs";

const sqs = new SQSClient({ region: AWS_REGION });
const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: AWS_REGION })
);

// === S3 helpers (yours) ===
const {
  putObject,
  getObject,
  getPresignedUrl,
  listByPrefix,
  s3Client,
  bucketName,
  getPresignedUploadUrl,
} = require("../db/s3");

// === DynamoDB video-metadata helpers (yours) ===
const { putVideoMetadata, getVideoMetadata } = require("../db/dynamodb");

// === Express router ===
const express = require("express");
const router = express.Router();

// -------------------------------
// Utility: owner / admin helpers
// -------------------------------
function ownerFromReq(req) {
  return (
    req.user?.["cognito:username"] ||
    req.user?.username ||
    (req.user?.email ? req.user.email.split("@")[0] : null) ||
    "unknown"
  );
}
function isAdminReq(req) {
  const groups = req.user?.["cognito:groups"] || [];
  return groups
    .map(String)
    .map((s) => s.toLowerCase())
    .includes("admin");
}

// ----------------------------------------
// Upload metadata record (direct S3 flows)
// ----------------------------------------
router.post("/record-upload", async (req, res) => {
  try {
    const { safeName, owner } = req.body;
    if (!safeName || !owner) {
      return res.status(400).json({ error: "Missing safeName or owner" });
    }
    await putVideoMetadata(safeName, [], owner);
    return res
      .status(201)
      .json({ message: "Metadata recorded", filename: safeName, owner });
  } catch (err) {
    console.error("Record upload error:", err);
    return res
      .status(500)
      .json({ error: err.message || "Failed to record metadata" });
  }
});

// ----------------------------------------
// Pre-signed upload URL (browser → S3)
// ----------------------------------------
router.post("/upload-url", async (req, res) => {
  try {
    const owner = ownerFromReq(req);
    const { filename, contentType } = req.body || {};
    if (!filename) return res.status(400).send("filename is required");
    const safeName = `${Date.now()}_${filename.replace(/[^\w.\-]+/g, "_")}`;
    const key = `uploads/${owner}/${safeName}`;
    const url = await getPresignedUploadUrl(
      key,
      3600,
      contentType || "application/octet-stream"
    );
    if (!url) return res.status(500).send("Failed to generate upload URL");
    res.json({ url, key, safeName });
  } catch (err) {
    console.error("Presigned upload URL error:", err);
    res.status(500).send("Failed to generate S3 upload URL");
  }
});

// ---------------------
// Direct upload (API → S3)
// ---------------------
router.post("/upload", async (req, res) => {
  try {
    const ctype = req.headers["content-type"] || "";
    if (!ctype.startsWith("multipart/form-data")) {
      return res
        .status(415)
        .send(
          `Wrong Content-Type. Expected multipart/form-data, got: ${ctype}`
        );
    }
    if (!req.files)
      return res
        .status(400)
        .send("No files found on request. Did you send FormData?");
    const video = req.files.video || req.files.file;
    if (!video)
      return res.status(400).send('Expected field "video" (or "file")');

    const originalName = path.basename(video.name || "upload");
    const safeName = `${Date.now()}_${originalName.replace(/[^\w.\-]+/g, "_")}`;
    const owner = ownerFromReq(req);
    const key = `uploads/${owner}/${safeName}`;

    const body = video.data?.length
      ? video.data
      : fs.readFileSync(video.tempFilePath);

    await putObject(key, body, video.mimetype, { owner });
    await putVideoMetadata(safeName, [], owner);

    return res
      .status(201)
      .json({ message: "Video uploaded to S3", filename: safeName, owner });
  } catch (err) {
    if (String(err?.message || "").includes("File size limit"))
      return res.status(413).send("File too large");
    if (req.aborted) return res.status(499).send("Client aborted upload");
    console.error("Upload error:", err);
    return res
      .status(500)
      .send("Upload failed: " + (err.message || "unknown error"));
  }
});

// ================================================
// TRANSCODING (A3): enqueue a job for the worker
// ================================================
async function createJob({ owner, inputKey, targetProfiles, more = {} }) {
  const jobId = randomUUID(); // Unique, no extra deps
  const item = {
    jobId,
    owner,
    status: "QUEUED",
    inputKey,
    targetProfiles,
    requestedAt: new Date().toISOString(),
    outputs: [],
    ...more,
  };
  await ddb.send(new PutCommand({ TableName: JOBS_TABLE, Item: item }));
  return item;
}
async function enqueueJob(message) {
  if (!QUEUE_URL) {
    throw new Error("QUEUE_URL not configured on the API service");
  }
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: QUEUE_URL,
      MessageBody: JSON.stringify(message),
    })
  );
}

// NOTE: This replaces the old in-process FFmpeg path.
// It now just records a job + pushes to SQS for the transcoderworker.
router.post("/transcode", async (req, res) => {
  try {
    let {
      filename,
      format = "mp4",
      preset = "medium",
      scale = "source",
      fps = "source",
      enhance = false,
      heavy,
    } = req.body || {};
    if (!filename) return res.status(400).send("filename is required");

    // Optional: interpret "heavy" as a preset bundle
    if (typeof heavy !== "undefined" && (heavy === true || heavy === "true")) {
      preset = "slow";
      scale = "1080p";
      fps = "60";
      enhance = true;
    }

    const owner = ownerFromReq(req);
    const inputKey = `uploads/${owner}/${filename}`;

    // Choose output profiles the worker will map to scale options
    const targetProfiles = ["720p", "source"]; // adjust as you like

    // 1) Job record
    const job = await createJob({
      owner,
      inputKey,
      targetProfiles,
      more: { format, preset, scale, fps, enhance },
    });

    // 2) Enqueue to SQS for the worker
    await enqueueJob({
      jobId: job.jobId,
      owner,
      inputKey,
      targetProfiles,
      requestedAt: job.requestedAt,
      format,
      preset,
      scale,
      fps,
      enhance,
    });

    return res.status(202).json({ jobId: job.jobId, status: "QUEUED" });
  } catch (err) {
    console.error("Enqueue transcode error:", err);
    return res
      .status(500)
      .send(err.message || "Failed to enqueue transcode job");
  }
});

// --------------------------------------------
// Job status (UI can poll while worker runs)
// --------------------------------------------
router.get("/jobs/:jobId", async (req, res) => {
  try {
    const me = ownerFromReq(req);
    const { Item } = await ddb.send(
      new GetCommand({
        TableName: JOBS_TABLE,
        Key: { jobId: req.params.jobId },
      })
    );
    if (!Item) return res.status(404).json({ error: "Not found" });
    if (Item.owner !== me && !isAdminReq(req))
      return res.status(403).json({ error: "Forbidden" });
    return res.json(Item);
  } catch (err) {
    console.error("Get job error:", err);
    return res.status(500).json({ error: "Failed to get job" });
  }
});

// -------------------------
// List S3 uploads (cached)
// -------------------------
router.get("/uploads", async (req, res) => {
  try {
    const admin = isAdminReq(req);
    const me = ownerFromReq(req);
    const prefix = admin ? "uploads/" : `uploads/${me}/`;
    const cacheKey = `uploads:${admin ? "admin" : me}`;

    // try cache, never fail the request if cache is down
    try {
      const cached = await cache.get(cacheKey);
      if (cached) {
        return res.json({ items: JSON.parse(cached), cached: true });
      }
    } catch (_) {}

    const objs = await listByPrefix(prefix);
    const items = objs
      .filter((o) => o.Key && !o.Key.endsWith("/"))
      .map((o) => {
        const parts = o.Key.split("/");
        const name = parts.pop();
        const owner = admin ? parts[1] || me : me;
        return {
          name,
          owner,
          lastModified: o.LastModified || null,
          size: o.Size ?? null,
        };
      });

    // best-effort cache set
    try {
      await cache.set(cacheKey, JSON.stringify(items), 30);
    } catch (_) {}

    res.json({ items, cached: false });
  } catch (err) {
    console.error("S3 uploads list error:", err);
    res.status(500).send("Failed to list uploads");
  }
});

// ----------------------------
// List S3 processed variants
// ----------------------------
router.get("/processed", async (req, res) => {
  try {
    const admin = isAdminReq(req);
    const me = ownerFromReq(req);
    const pfxProcessed = admin ? "processed/" : `processed/${me}/`;
    const pfxUploads = admin ? "uploads/" : `uploads/${me}/`;

    // list processed
    const processedObjs = await listByPrefix(pfxProcessed);

    // map originals by owner:baseName
    const uploadObjs = await listByPrefix(pfxUploads);
    const baseMap = new Map();
    for (const u of uploadObjs) {
      if (!u.Key || u.Key.endsWith("/")) continue;
      const upParts = u.Key.split("/");
      const uOwner = admin ? upParts[1] || me : me;
      const uName = upParts.pop();
      const uBase = uName.replace(/\.[^.]+$/, "");
      baseMap.set(`${uOwner}:${uBase}`, uName);
    }

    const items = processedObjs
      .filter((o) => o.Key && !o.Key.endsWith("/"))
      .map((o) => {
        const parts = o.Key.split("/");
        const name = parts.pop();
        const owner = admin ? parts[1] || me : me;
        const noExt = name.replace(/\.[^.]+$/, "");
        const m = noExt.match(/^(.+?)_(.+)$/);
        const base = m ? m[1] : noExt;
        const variant = m ? m[2] : "";
        const original = baseMap.get(`${owner}:${base}`) || base;
        return {
          name,
          owner,
          original,
          variant,
          lastModified: o.LastModified || null,
          size: o.Size ?? null,
        };
      });

    res.json({ items });
  } catch (err) {
    console.error("S3 processed list error:", err);
    res.status(500).send("Failed to list processed");
  }
});

// ----------------------
// Presigned download URL
// ----------------------
router.get("/download/:type/:name", async (req, res) => {
  try {
    const me = ownerFromReq(req);
    const type = req.params.type; // 'uploads' or 'processed'
    const name = req.params.name;

    const key = `${type}/${me}/${name}`;
    const url = await getPresignedUrl(key);
    if (!url) return res.sendStatus(404);
    res.json({ url });
  } catch (err) {
    console.error("Presign error:", err);
    res.status(500).send("Failed to generate S3 download URL");
  }
});

module.exports = router;
