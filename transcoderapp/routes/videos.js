// transcoderapp/routes/videos.js
const express = require("express");
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

// === AWS SDK ===
const { SQSClient, SendMessageCommand } = require("@aws-sdk/client-sqs");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
} = require("@aws-sdk/lib-dynamodb");

// === S3 + DynamoDB helpers ===
const {
  putObject,
  getPresignedUploadUrl,
  listByPrefix,
  getPresignedUrl,
} = require("../db/s3");
const { putVideoMetadata } = require("../db/dynamodb");

// === Optional Memcached ===
const MEMCACHED_ENDPOINT = process.env.MEMCACHED_ENDPOINT;
let cache = {
  async get() {
    return null;
  },
  async set() {},
};

if (MEMCACHED_ENDPOINT) {
  try {
    const Memcached = require("memcached");
    const mc = new Memcached(MEMCACHED_ENDPOINT, {
      timeout: 1000,
      retries: 0,
      failures: 0,
    });
    cache.get = (key) =>
      new Promise((resolve) => {
        mc.get(key, (err, data) => resolve(err ? null : data));
      });
    cache.set = (key, value, ttl) =>
      new Promise((resolve) => {
        mc.set(key, value, ttl, () => resolve());
      });
    console.log("[cache] Memcached enabled:", MEMCACHED_ENDPOINT);
  } catch (e) {
    console.warn("[cache] Failed to init Memcached:", e?.message || e);
  }
} else {
  console.log("[cache] Memcached disabled (no MEMCACHED_ENDPOINT set)");
}

const router = express.Router();

// -----------------------------
// Helpers
// -----------------------------
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
  return groups.map((g) => String(g).toLowerCase()).includes("admin");
}

// 🧠 Dynamic env + clients (fresh each request)
function getAws() {
  const REGION = process.env.AWS_REGION || "ap-southeast-2";
  const QUEUE_URL = process.env.QUEUE_URL;
  const JOBS_TABLE =
    process.env.JOBS_TABLE || process.env.TABLE_NAME || "transcoder-jobs";

  const sqs = new SQSClient({ region: REGION });
  const ddb = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: REGION })
  );

  return { REGION, QUEUE_URL, JOBS_TABLE, sqs, ddb };
}

// ----------------------------------------
// Record upload metadata
// ----------------------------------------
router.post("/record-upload", async (req, res) => {
  try {
    const { safeName, owner } = req.body;
    if (!safeName || !owner) {
      return res.status(400).json({ error: "Missing safeName or owner" });
    }
    await putVideoMetadata(safeName, [], owner);
    res
      .status(201)
      .json({ message: "Metadata recorded", filename: safeName, owner });
  } catch (err) {
    console.error("[record-upload] error:", err);
    res.status(500).json({ error: err.message || "Failed to record metadata" });
  }
});

// ----------------------------------------
// Presigned S3 upload URL
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
    console.error("[upload-url] error:", err);
    res.status(500).send("Failed to generate S3 upload URL");
  }
});

// ----------------------------------------
// Direct upload (multipart/form-data)
// ----------------------------------------
router.post("/upload", async (req, res) => {
  try {
    const ctype = req.headers["content-type"] || "";
    if (!ctype.startsWith("multipart/form-data")) {
      return res.status(415).send("Expected multipart/form-data");
    }
    if (!req.files) return res.status(400).send("No files found");
    const video = req.files.video || req.files.file;
    if (!video) return res.status(400).send('Expected field "video"');

    const originalName = path.basename(video.name || "upload");
    const safeName = `${Date.now()}_${originalName.replace(/[^\w.\-]+/g, "_")}`;
    const owner = ownerFromReq(req);
    const key = `uploads/${owner}/${safeName}`;

    const body = video.data?.length
      ? video.data
      : fs.readFileSync(video.tempFilePath);

    await putObject(key, body, video.mimetype, { owner });
    await putVideoMetadata(safeName, [], owner);

    res
      .status(201)
      .json({ message: "Uploaded to S3", filename: safeName, owner });
  } catch (err) {
    console.error("[upload] error:", err);
    res.status(500).send(err.message || "Upload failed");
  }
});

// ================================================
// Transcoding: enqueue a job for the worker
// ================================================
async function createJob({
  ddb,
  JOBS_TABLE,
  owner,
  inputKey,
  targetProfiles,
  more,
}) {
  const jobId = randomUUID();
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
async function enqueueJob({ sqs, QUEUE_URL, message }) {
  if (!QUEUE_URL) throw new Error("QUEUE_URL not configured");
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: QUEUE_URL,
      MessageBody: JSON.stringify(message),
    })
  );
}

router.post("/transcode", async (req, res) => {
  const { sqs, ddb, JOBS_TABLE, QUEUE_URL } = getAws();
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

    // interpret heavy preset
    if (String(heavy) === "true" || heavy === true) {
      preset = "slow";
      scale = "1080p";
      fps = "60";
      enhance = true;
    }

    const owner = ownerFromReq(req);
    const inputKey = `uploads/${owner}/${filename}`;
    const targetProfiles = ["source"];

    const job = await createJob({
      ddb,
      JOBS_TABLE,
      owner,
      inputKey,
      targetProfiles,
      more: { format, preset, scale, fps, enhance },
    });

    await enqueueJob({
      sqs,
      QUEUE_URL,
      message: { ...job },
    });

    res.status(202).json({ jobId: job.jobId, status: "QUEUED" });
  } catch (err) {
    console.error("[transcode] error:", err);
    res.status(500).send(err.message || "Failed to enqueue transcode job");
  }
});

// --------------------------------------------
// Job status
// --------------------------------------------
router.get("/jobs/:jobId", async (req, res) => {
  const { ddb, JOBS_TABLE } = getAws();
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
    res.json(Item);
  } catch (err) {
    console.error("[job-status] error:", err);
    res.status(500).json({ error: "Failed to get job" });
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

    const cached = await cache.get(cacheKey).catch(() => null);
    if (cached) return res.json({ items: JSON.parse(cached), cached: true });

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

    await cache.set(cacheKey, JSON.stringify(items), 30).catch(() => {});
    res.json({ items, cached: false });
  } catch (err) {
    console.error("[uploads-list] error:", err);
    res.status(500).send("Failed to list uploads");
  }
});

// ----------------------------
// List processed variants
// ----------------------------
router.get("/processed", async (req, res) => {
  try {
    const admin = isAdminReq(req);
    const me = ownerFromReq(req);
    const pfxProcessed = admin ? "processed/" : `processed/${me}/`;
    const pfxUploads = admin ? "uploads/" : `uploads/${me}/`;

    const processedObjs = await listByPrefix(pfxProcessed);
    const uploadObjs = await listByPrefix(pfxUploads);

    const baseMap = new Map();
    for (const u of uploadObjs) {
      if (!u.Key || u.Key.endsWith("/")) continue;
      const parts = u.Key.split("/");
      const uOwner = admin ? parts[1] || me : me;
      const uName = parts.pop();
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
          lastModified: o.LastModified,
          size: o.Size ?? null,
        };
      });

    res.json({ items });
  } catch (err) {
    console.error("[processed-list] error:", err);
    res.status(500).send("Failed to list processed");
  }
});

// ----------------------
// Presigned download URL
// ----------------------
router.get("/download/:type/:name", async (req, res) => {
  try {
    const me = ownerFromReq(req);
    const { type, name } = req.params;
    const key = `${type}/${me}/${name}`;
    const url = await getPresignedUrl(key);
    if (!url) return res.sendStatus(404);
    res.json({ url });
  } catch (err) {
    console.error("[download-url] error:", err);
    res.status(500).send("Failed to generate download URL");
  }
});

module.exports = router;
