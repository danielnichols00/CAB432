//VIDEOS ROUTING - Built with AI assistance

const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const { transcodeVideo } = require("../workers/transcode");
const { putObject } = require("../db/s3");
const {
  putVideoMetadata,
  getVideoMetadata,
  queryAllVideos,
  scanAllVideos,
} = require("../db/dynamodb");

//Locations for temp data (still needed for ffmpeg)
const DATA_DIR = path.join(__dirname, "..", "data");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const PROCESSED_DIR = path.join(DATA_DIR, "processed");

function ownerFromReq(req) {
  return (
    req.user?.["cognito:username"] ||
    req.user?.username ||
    (req.user?.email ? req.user.email.split("@")[0] : null) ||
    "unknown"
  );
}

// routes/videos.js (replace your /upload handler)
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

    const originalName = require("path").basename(video.name || "upload");
    const safeName = `${Date.now()}_${originalName.replace(/[^\w.\-]+/g, "_")}`;

    const body =
      video.data && video.data.length
        ? video.data
        : require("fs").readFileSync(video.tempFilePath);

    const owner = ownerFromReq(req);

    // (optional) tag S3 object with owner metadata
    await putObject(safeName, body, video.mimetype, { owner });

    // metadata in DynamoDB
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

// POST /videos/transcode
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

  // heavy back-compat…
  if (typeof heavy !== "undefined" && (heavy === true || heavy === "true")) {
    preset = "slow";
    scale = "1080p";
    fps = "60";
    enhance = true;
  }

  const { getObject, putObject } = require("../s3");

  const owner = ownerFromReq(req);

  // download input from S3
  let inputBuffer;
  try {
    inputBuffer = await getObject(filename, true);
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

    // upload processed back to S3 (optionally tag with owner)
    const processedBuffer = fs.readFileSync(outputPath);
    await putObject(outName, processedBuffer, "video/" + format, { owner });

    // update DynamoDB metadata for THIS owner
    const meta = await getVideoMetadata(filename, owner);
    const processed = Array.isArray(meta?.processed)
      ? meta.processed.slice()
      : [];
    if (!processed.includes(outName)) processed.push(outName);
    await putVideoMetadata(filename, processed, owner);

    res.json({
      message: "Video transcoded and uploaded to S3",
      output: outName,
      owner,
    });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

//GET /videos - lists metadata (seconjd data type)
router.get("/", async (req, res) => {
  try {
    const groups = req.user?.["cognito:groups"] || [];
    const isAdmin = groups.includes("admin");
    const owner = isAdmin ? "*" : ownerFromReq(req); // "*" => all owners

    const items = await queryAllVideos(owner);
    res.json({ files: items, owner, isAdmin });
  } catch (err) {
    console.error("Error querying videos:", err);
    res.status(500).send("Failed to query videos");
  }
});

//GET /videos/download/
router.get("/download/:type/:name", async (req, res) => {
  const { getPresignedUrl } = require("../db/s3");
  try {
    const presignedUrl = await getPresignedUrl(req.params.name);
    if (!presignedUrl) return res.sendStatus(404);
    res.json({ url: presignedUrl });
  } catch (err) {
    res.status(500).send("Failed to generate S3 download URL");
  }
});

module.exports = router;
