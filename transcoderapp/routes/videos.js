//VIDEOS ROUTING - Built with AI assistance

const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const { transcodeVideo } = require("../workers/transcode");

//Locations for data
const DATA_DIR = path.join(__dirname, "..", "data");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const PROCESSED_DIR = path.join(DATA_DIR, "processed");
const DB_PATH = path.join(DATA_DIR, "db.json");

//Ensure database exists
function ensureData() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
  if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);
  if (!fs.existsSync(PROCESSED_DIR)) fs.mkdirSync(PROCESSED_DIR);
  if (!fs.existsSync(DB_PATH))
    fs.writeFileSync(DB_PATH, JSON.stringify({ files: [] }, null, 2));
}
ensureData();

function readDB() {
  return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
}
function writeDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
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
    const uploadPath = path.join(UPLOADS_DIR, safeName);

    await video.mv(uploadPath); // move from temp to uploads

    const db = readDB();
    db.files.push({
      owner: req.user?.username || "unknown",
      original: safeName,
      processed: [],
      uploadedAt: new Date().toISOString(),
    });
    writeDB(db);

    return res
      .status(201)
      .json({ message: "Video uploaded", filename: safeName });
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

  const inputPath = path.join(UPLOADS_DIR, filename);
  if (!fs.existsSync(inputPath)) return res.status(404).send("Video not found");

  try {
    const outputPath = await transcodeVideo(inputPath, {
      format,
      preset,
      scale,
      fps,
      enhance,
    });
    const outName = path.basename(outputPath);

    // update DB
    const db = readDB();
    const rec = db.files.find((f) => f.original === filename);
    if (rec) {
      if (!rec.processed.includes(outName)) rec.processed.push(outName);
      rec.lastTranscodedAt = new Date().toISOString();
    } else {
      db.files.push({
        owner: req.user?.username || "unknown",
        original: filename,
        processed: [outName],
        uploadedAt: new Date().toISOString(),
        lastTranscodedAt: new Date().toISOString(),
      });
    }
    writeDB(db);

    res.json({ message: "Video transcoded", output: outName });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

//GET /videos - lists metadata (seconjd data type)
router.get("/", (_req, res) => {
  const db = readDB();
  res.json(db);
});

//GET /videos/download/
router.get("/download/:type/:name", (req, res) => {
  const base = req.params.type === "processed" ? PROCESSED_DIR : UPLOADS_DIR;
  const filePath = path.join(base, req.params.name);
  if (!fs.existsSync(filePath)) return res.sendStatus(404);
  res.download(filePath);
});

module.exports = router;
