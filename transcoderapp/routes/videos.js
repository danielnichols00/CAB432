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

const router = express.Router();

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
// Transcoding: create parent job & enqueue variants
// ================================================

// Valid profiles we accept from clients
const VALID_PROFILES = new Set(["source", "1080p", "720p"]);

// Create a parent job record (one row) that tracks all variants
async function createJob({
  ddb,
  JOBS_TABLE,
  owner,
  inputKey,
  targetProfiles, // e.g. ["source","1080p","720p"]
  more, // { format, preset, scale, fps, enhance }
}) {
  const jobId = randomUUID();
  const requestedAt = new Date().toISOString();

  const item = {
    jobId,
    owner,
    status: "QUEUED",
    inputKey,
    // store the full set of requested profiles
    requestedProfiles: targetProfiles,
    // bookkeeping for UI/status
    totalVariants: targetProfiles.length,
    completedVariants: 0,
    outputs: [],
    requestedAt,
    mode: "split-variants",
    ...more, // format/preset/scale/fps/enhance
  };

  await ddb.send(new PutCommand({ TableName: JOBS_TABLE, Item: item }));
  return item;
}

// Low-level enqueue helper; adds FIFO fields if needed
async function enqueueJob({ sqs, QUEUE_URL, message, delaySeconds = 0 }) {
  if (!QUEUE_URL) throw new Error("QUEUE_URL not configured");

  const isFifo = QUEUE_URL.endsWith(".fifo");
  const body = JSON.stringify(message);
  const cmdInput = {
    QueueUrl: QUEUE_URL,
    MessageBody: body,
  };

  if (delaySeconds > 0) {
    cmdInput.DelaySeconds = Math.min(Math.max(delaySeconds, 0), 900);
  }

  if (isFifo) {
    // group by owner so a single user's variants keep relative ordering,
    // but different users can process in parallel.
    cmdInput.MessageGroupId = message.owner || "default";
    cmdInput.MessageDeduplicationId = `${message.jobId}-${
      message.variant || "single"
    }-${randomUUID()}`;
  }

  await sqs.send(new SendMessageCommand(cmdInput));
}

// Enqueue one SQS message per variant (preferred for horizontal scaling)
async function enqueueVariantJobs({
  sqs,
  QUEUE_URL,
  baseJob, // returned from createJob()
  targetProfiles,
}) {
  await Promise.all(
    targetProfiles.map((profile) =>
      enqueueJob({
        sqs,
        QUEUE_URL,
        message: {
          // Parent job info:
          jobId: baseJob.jobId,
          owner: baseJob.owner,
          inputKey: baseJob.inputKey,

          // Worker payload (isolate to a single variant):
          targetProfiles: [profile],
          format: baseJob.format,
          preset: baseJob.preset,
          scale: baseJob.scale,
          fps: baseJob.fps,
          enhance: baseJob.enhance,

          // Optional metadata for logging/metrics:
          variant: profile,
          parentMode: "split-variants",
          requestedAt: baseJob.requestedAt,
        },
      })
    )
  );
}

// ----------------------------------------
// POST /transcode  → create job & enqueue
// ----------------------------------------
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
      targetProfiles, // optional array from client
    } = req.body || {};

    if (!filename) return res.status(400).send("filename is required");

    // interpret heavy preset
    if (String(heavy) === "true" || heavy === true) {
      preset = "slow";
      scale = "1080p";
      fps = "60";
      enhance = true;
    }

    // Validate/normalise targetProfiles; default to ["source"]
    let profiles = Array.isArray(targetProfiles)
      ? targetProfiles.filter((p) => VALID_PROFILES.has(String(p)))
      : ["source"];

    if (profiles.length === 0) profiles = ["source"];

    const owner = ownerFromReq(req);
    const inputKey = `uploads/${owner}/${filename}`;

    // Create a single parent job row
    const baseJob = await createJob({
      ddb,
      JOBS_TABLE,
      owner,
      inputKey,
      targetProfiles: profiles,
      more: { format, preset, scale, fps, enhance },
    });

    // Enqueue one SQS message per variant so workers/instances can parallelise
    await enqueueVariantJobs({
      sqs,
      QUEUE_URL,
      baseJob,
      targetProfiles: profiles,
    });

    res.status(202).json({
      jobId: baseJob.jobId,
      status: "QUEUED",
      variants: profiles,
    });
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
