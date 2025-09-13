//VIDEOS ROUTING - Built with AI assistance

const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const { transcodeVideo } = require("../transcode");

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
  if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify({ files: [] }, null, 2));
}
ensureData();

function readDB() {
  return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
}
function writeDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

//POST /videos/upload - 201 Created on success
router.post("/upload", (req, res) => {
  if (!req.files || !req.files.video) return res.status(400).send("No video uploaded");

  const video = req.files.video;
  const safeName = `${Date.now()}_${video.name.replace(/\s+/g, "_")}`;
  const uploadPath = path.join(UPLOADS_DIR, safeName);

  video.mv(uploadPath, (err) => {
    if (err) return res.status(500).send(err.message);

    const db = readDB();
    db.files.push({
      owner: req.user?.username || "unknown",
      original: safeName,
      processed: [],
      uploadedAt: new Date().toISOString()
    });
    writeDB(db);

    res.status(201).json({ message: "Video uploaded", filename: safeName });
  });
});

//POST /videos/transcode - calls ffmpeg to transcode video (CPU Intensive)
router.post("/transcode", async (req, res) => {
  const { filename, format = "mp4", heavy = true } = req.body;
  if (!filename) return res.status(400).send("filename is required");

  const inputPath = path.join(UPLOADS_DIR, filename);
  if (!fs.existsSync(inputPath)) return res.status(404).send("Video not found");

  try {
    const outputPath = await transcodeVideo(inputPath, { format, heavy });
    const outName = path.basename(outputPath);

    const db = readDB();
    const rec = db.files.find(f => f.original === filename);
    if (rec) {
      if (!rec.processed.includes(outName)) rec.processed.push(outName);
      rec.lastTranscodedAt = new Date().toISOString();
    } else {
      db.files.push({
        owner: req.user?.username || "unknown",
        original: filename,
        processed: [outName],
        uploadedAt: new Date().toISOString(),
        lastTranscodedAt: new Date().toISOString()
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
