// workers/transcode.js
// TRANSCODE FILE

const fs = require("fs");
const path = require("path");
const ffmpeg = require("fluent-ffmpeg");

// Use bundled binaries so it works on Windows/EC2/etc.
const ffmpegPath = require("ffmpeg-static");
const ffprobePath = require("ffprobe-static").path;
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

// Folders
const DATA_DIR = path.join(__dirname, "..", "data");
const PROCESSED_DIR = path.join(DATA_DIR, "processed");
fs.mkdirSync(PROCESSED_DIR, { recursive: true });

// Maps for quality knobs
const PRESET_MAP = new Set(["fast", "medium", "slow"]); // default: medium
const CRF_MAP = {
  mp4: { fast: 24, medium: 23, slow: 21 },
  webm: { fast: 34, medium: 32, slow: 28 },
};
const QSCALE_MAP = { fast: 5, medium: 4, slow: 3 }; // AVI mpeg4

/**
 * Transcode.
 * @param {string} inputPath
 * @param {object} opts
 * @param {'mp4'|'webm'|'avi'} opts.format
 * @param {'fast'|'medium'|'slow'} [opts.preset='medium']
 * @param {'source'|'1080p'|'720p'} [opts.scale='source']
 * @param {'source'|string|number} [opts.fps='source'] e.g. '30'|'60'
 * @param {boolean} [opts.enhance=false] apply mild eq filter
 */
// workers/transcode.js (only the changed bits shown)
function transcodeVideo(
  inputPath,
  {
    format = "mp4",
    preset = "medium",
    scale = "source",
    fps = "source",
    enhance = false,
  } = {}
) {
  return new Promise((resolve, reject) => {
    // sanitize
    preset = PRESET_MAP.has(String(preset)) ? String(preset) : "medium";
    scale = ["source", "1080p", "720p"].includes(String(scale))
      ? String(scale)
      : "source";
    fps = fps === "source" ? "source" : Number(fps) || "source";

    const base = path.parse(inputPath).name;

    // 👇 Build a stable, readable variant tag
    const variant = [
      preset, // fast|medium|slow
      scale === "source" ? "src" : scale, // src|1080p|720p
      fps === "source" ? "src" : `${fps}fps`, // src|30fps|60fps
      enhance ? "enh" : null, // enh (only if true)
    ]
      .filter(Boolean)
      .join("_");

    const outName = `${base}_${variant}.${format}`; // e.g. clip_medium_1080p_60fps_enh.mp4
    const outputPath = path.join(PROCESSED_DIR, outName);

    const cmd = ffmpeg(inputPath);

    if (format === "mp4") {
      cmd
        .videoCodec("libx264")
        .audioCodec("aac")
        .outputOptions([
          "-preset",
          preset, // fast|medium|slow
          "-crf",
          String(CRF_MAP.mp4[preset]),
          "-movflags",
          "+faststart",
        ]);
    } else if (format === "webm") {
      cmd
        .videoCodec("libvpx-vp9")
        .audioCodec("libopus")
        .outputOptions(["-b:v", "0", "-crf", String(CRF_MAP.webm[preset])]);
    } else if (format === "avi") {
      cmd
        .videoCodec("mpeg4")
        .audioCodec("mp3")
        .outputOptions(["-qscale:v", String(QSCALE_MAP[preset])]);
    } else {
      return reject(new Error(`Unsupported format: ${format}`));
    }

    if (scale === "1080p") cmd.size("1920x1080");
    if (scale === "720p") cmd.size("1280x720");
    if (fps !== "source") cmd.fps(fps);

    if (enhance) {
      cmd.videoFilters("eq=brightness=0.02:contrast=1.08:gamma=1.04");
    }

    cmd
      .on("end", () => resolve(outputPath))
      .on("error", (err) => reject(new Error(`FFmpeg failed: ${err.message}`)))
      .save(outputPath);
  });
}

module.exports = { transcodeVideo };
