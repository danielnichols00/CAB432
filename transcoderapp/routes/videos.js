// MEMCACHED SETUP
const Memcached = require('memcached');
const memcached = new Memcached('n11713739-cache.km2jzi.0001.apse2.cache.amazonaws.com:11211');
memcached.aGet = (key) => new Promise((resolve, reject) => {
  memcached.get(key, (err, data) => err ? reject(err) : resolve(data));
});
memcached.aSet = (key, value, ttl) => new Promise((resolve, reject) => {
  memcached.set(key, value, ttl, (err) => err ? reject(err) : resolve());
});
// routes/videos.js
const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const { transcodeVideo } = require("../workers/transcode");
const {
  putObject,
  getObject,
  getPresignedUrl,
  listByPrefix,
  s3Client,
  bucketName,
  getPresignedUploadUrl,
} = require("../db/s3");

// PRE-SIGNED UPLOAD URL
router.post("/upload-url", async (req, res) => {
  try {
    const owner = ownerFromReq(req);
    const { filename, contentType } = req.body || {};
    if (!filename) return res.status(400).send("filename is required");
    const safeName = `${Date.now()}_${filename.replace(/[^\w.\-]+/g, "_")}`;
    const key = `uploads/${owner}/${safeName}`;
    const url = await getPresignedUploadUrl(key, 3600, contentType || "application/octet-stream");
    if (!url) return res.status(500).send("Failed to generate upload URL");
    res.json({ url, key, safeName });
  } catch (err) {
    console.error("Presigned upload URL error:", err);
    res.status(500).send("Failed to generate S3 upload URL");
  }
});
const {
  putVideoMetadata,
  getVideoMetadata,

} = require("../db/dynamodb");

// FFMPEG TEMP
const DATA_DIR = path.join(__dirname, "..", "data");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const PROCESSED_DIR = path.join(DATA_DIR, "processed");
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(PROCESSED_DIR, { recursive: true });

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

// UPLOAD 
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

// TRANSCODING
router.post("/transcode", async (req, res) => {
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

  if (typeof heavy !== "undefined" && (heavy === true || heavy === "true")) {
    preset = "slow";
    scale = "1080p";
    fps = "60";
    enhance = true;
  }

  const owner = ownerFromReq(req);
  const inKey = `uploads/${owner}/${filename}`;

  // DOWNLOAD to LOCAL TEMP
  let inputBuffer;
  try {
    inputBuffer = await getObject(inKey, true);
  } catch {
    return res.status(404).send("Video not found in S3");
  }

  const tempInputPath = path.join(UPLOADS_DIR, filename);
  fs.writeFileSync(tempInputPath, inputBuffer);

  try {
    const outputPath = await transcodeVideo(tempInputPath, {
      format,
      preset,
      scale,
      fps,
      enhance,
    });
    const outName = path.basename(outputPath);
    const outKey = `processed/${owner}/${outName}`;

    await putObject(outKey, fs.readFileSync(outputPath), "video/" + format, {
      owner,
    });

    // DYNAMODB OWNER UPDATE
    const meta = await getVideoMetadata(filename, owner);
    const processed = Array.isArray(meta?.processed)
      ? meta.processed.slice()
      : [];
    if (!processed.includes(outName)) processed.push(outName);
    await putVideoMetadata(filename, processed, owner);

    try {
      fs.rmSync(tempInputPath, { force: true });
    } catch {}
    try {
      fs.rmSync(outputPath, { force: true });
    } catch {}

    res.json({
      message: "Video transcoded and uploaded to S3",
      output: outName,
      owner,
    });
  } catch (err) {
    console.error("Transcode error:", err);
    res.status(500).send(err.message || "Transcode failed");
  }
});

// S3 UPLOADS LIST
router.get("/uploads", async (req, res) => {
  try {
    const admin = isAdminReq(req);
    const me = ownerFromReq(req);
    const prefix = admin ? "uploads/" : `uploads/${me}/`;
    const cacheKey = `uploads:${admin ? 'admin' : me}`;
    let cached = await memcached.aGet(cacheKey);
    if (cached) {
      // Return cached data
      return res.json({ items: JSON.parse(cached), cached: true });
    }

    const objs = await listByPrefix(prefix);
    const items = objs
      .filter((o) => o.Key && !o.Key.endsWith("/"))
      .map((o) => {
        const parts = o.Key.split("/");
        const name = parts.pop(); // filename.ext
        const owner = admin ? parts[1] || me : me;
        return {
          name,
          owner,
          lastModified: o.LastModified || null,
          size: o.Size ?? null,
        };
      });

    // STORE IN CACHE FOR 30S
    await memcached.aSet(cacheKey, JSON.stringify(items), 30);
    res.json({ items, cached: false });
  } catch (err) {
    console.error("S3 uploads list error:", err);
    res.status(500).send("Failed to list uploads");
  }
});

// PROCESSED LIST
router.get("/processed", async (req, res) => {
  try {
    const admin = isAdminReq(req);
    const me = ownerFromReq(req);
    const pfxProcessed = admin ? "processed/" : `processed/${me}/`;
    const pfxUploads = admin ? "uploads/" : `uploads/${me}/`;

    // list processed
    const processedObjs = await listByPrefix(pfxProcessed);

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

// DOWNLOAD
router.get("/download/:type/:name", async (req, res) => {
  try {
    const me = ownerFromReq(req);
    const type = req.params.type; // "uploads" | "processed"
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
