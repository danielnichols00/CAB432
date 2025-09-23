//VIDEOS ROUTING - Built with AI assistance

const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const { transcodeVideo } = require("../workers/transcode");
const { putObject } = require("../s3");
const {
  putVideoMetadata,
  getVideoMetadata,
  queryAllVideos,
  scanAllVideos,
} = require("../dynamodb");

//Locations for temp data (still needed for ffmpeg)
const DATA_DIR = path.join(__dirname, "..", "data");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const PROCESSED_DIR = path.join(DATA_DIR, "processed");

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

    if (!req.files) {
      return res
        .status(400)
        .send("No files found on request. Did you send FormData?");
    }

    const video = req.files.video || req.files.file; // accept both names
    if (!video)
      return res.status(400).send('Expected field "video" (or "file")');

    const originalName = path.basename(video.name || "upload");
    const safeName = `${Date.now()}_${originalName.replace(/[^\w.\-]+/g, "_")}`;
    // Test log to verify console output and function call
    console.log("Calling putObject for:", safeName);
    // Upload file to S3 instead of local folder
    await putObject(safeName, video.data);

  // Store metadata in DynamoDB
  await putVideoMetadata(safeName, [], req.user?.username || "unknown");

    return res
      .status(201)
      .json({ message: "Video uploaded to S3", filename: safeName });
  } catch (err) {
    // Helpful messages
    if (String(err?.message || "").includes("File size limit")) {
      return res.status(413).send("File too large (hit server limit)");
    }
    if (req.aborted) {
      return res.status(499).send("Client aborted upload");
    }
    console.error("Upload error:", err);
    return res
      .status(500)
      .send("Upload failed: " + (err.message || "unknown error"));
  }
});

// POST /videos/transcode
router.post("/transcode", async (req, res) => {
  // New shape with sane defaults:
  let {
    filename,
    format = "mp4",
    preset = "medium", // fast|medium|slow
    scale = "source", // source|1080p|720p
    fps = "source", // source|30|60
    enhance = false, // boolean
    heavy, // deprecated back-compat
  } = req.body || {};

  if (!filename) return res.status(400).send("filename is required");

  // Back-compat: if an old client sends heavy=true, map to slow+1080p+60fps+enhance
  if (typeof heavy !== "undefined") {
    const h = heavy === true || heavy === "true";
    if (h) {
      preset = "slow";
      scale = "1080p";
      fps = "60";
      enhance = true;
    }
  }

  // Download input file from S3
  const { getObject, putObject } = require("../s3");
  let inputBuffer;
  try {
    inputBuffer = await getObject(filename, true); // get as Buffer
  } catch (err) {
    return res.status(404).send("Video not found in S3");
  }

  // Save to temp file for ffmpeg
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

    // Upload processed file to S3
    const processedBuffer = fs.readFileSync(outputPath);
    await putObject(outName, processedBuffer);

    // Update metadata in DynamoDB
    // Get existing metadata
    let meta = await getVideoMetadata(
      filename,
      req.user?.username || "unknown"
    );
    let processed = meta?.processed || [];
    if (!processed.includes(outName)) processed.push(outName);
    await putVideoMetadata(
      filename,
      processed,
      req.user?.username || "unknown"
    );

    res.json({
      message: "Video transcoded and uploaded to S3",
      output: outName,
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
    const owner =
      req.user?.username || req.user?.["cognito:username"] || "unknown";

    const items = isAdmin ? await scanAllVideos() : await queryAllVideos(owner);
    res.json({ files: items });
  } catch (err) {
    console.error("Error querying videos:", err);
    res.status(500).send("Failed to query videos");
  }
});

//GET /videos/download/
router.get("/download/:type/:name", async (req, res) => {
  const { getPresignedUrl } = require("../s3");
  try {
    const presignedUrl = await getPresignedUrl(req.params.name);
    if (!presignedUrl) return res.sendStatus(404);
    res.json({ url: presignedUrl });
  } catch (err) {
    res.status(500).send("Failed to generate S3 download URL");
  }
});

module.exports = router;
