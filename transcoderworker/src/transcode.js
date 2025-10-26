// transcoderworker/src/transcode.js
const fs = require("fs");
const path = require("path");
const ffmpeg = require("fluent-ffmpeg");

// Use bundled binaries so it works on Windows/EC2/etc (install these in the WORKER package.json)
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

// Env knobs
const THREADS = String(process.env.FFMPEG_THREADS || "0"); // 0 = auto
const AUDIO_BITRATE = String(process.env.AUDIO_BITRATE || "128k");

/**
 * Build AR-safe scale+pad filters for a 16:9 target.
 * Keeps original AR (no stretching), letterboxes as needed.
 */
function scalePadFilter(targetW, targetH) {
  // Use exact integers; assumes targetW:targetH = 16:9 (e.g., 1920x1080, 1280x720)
  return [
    `scale=w=${targetW}:h=${targetH}:force_original_aspect_ratio=decrease`,
    `pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2`,
  ].join(","); // single filter chain
}

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
    preset = PRESET_MAP.has(String(preset)) ? String(preset) : "medium";
    scale = ["source", "1080p", "720p"].includes(String(scale))
      ? String(scale)
      : "source";
    fps = fps === "source" ? "source" : Number(fps) || "source";

    const base = path.parse(inputPath).name;
    const variant = [
      preset,
      scale === "source" ? "src" : scale,
      fps === "source" ? "src" : `${fps}fps`,
      enhance ? "enh" : null,
    ]
      .filter(Boolean)
      .join("_");

    const outName = `${base}_${variant}.${format}`;
    const outputPath = path.join(PROCESSED_DIR, outName);

    const cmd = ffmpeg(inputPath);

    // keep ffmpeg quiet by default
    cmd.addOptions([
      "-nostdin",
      "-hide_banner",
      "-nostats",
      "-loglevel",
      process.env.FFMPEG_LOGLEVEL || "error",
    ]);
    cmd.on("stderr", () => {});

    // Common output opts
    const commonOut = ["-threads", THREADS];

    // Video & audio codec + quality
    if (format === "mp4") {
      cmd
        .videoCodec("libx264")
        .audioCodec("aac")
        .outputOptions([
          ...commonOut,
          "-preset",
          preset,
          "-crf",
          String(CRF_MAP.mp4[preset]),
          "-movflags",
          "+faststart",
          "-pix_fmt",
          "yuv420p",
          "-b:a",
          AUDIO_BITRATE,
        ]);
    } else if (format === "webm") {
      cmd
        .videoCodec("libvpx-vp9")
        .audioCodec("libopus")
        .outputOptions([
          ...commonOut,
          "-b:v",
          "0",
          "-crf",
          String(CRF_MAP.webm[preset]),
          "-row-mt",
          "1", // row-based multi-threading
          "-tile-columns",
          "1", // modest tiling for parallelism
          "-frame-parallel",
          "1",
          "-pix_fmt",
          "yuv420p",
          "-b:a",
          AUDIO_BITRATE,
        ]);
    } else if (format === "avi") {
      cmd
        .videoCodec("mpeg4")
        .audioCodec("mp3")
        .outputOptions([
          ...commonOut,
          "-qscale:v",
          String(QSCALE_MAP[preset]),
          "-pix_fmt",
          "yuv420p",
          "-b:a",
          AUDIO_BITRATE,
        ]);
    } else {
      return reject(new Error(`Unsupported format: ${format}`));
    }

    // Scaling (AR-safe)
    if (scale === "1080p") {
      cmd.videoFilters(scalePadFilter(1920, 1080));
    } else if (scale === "720p") {
      cmd.videoFilters(scalePadFilter(1280, 720));
    }

    // FPS override
    if (fps !== "source") cmd.fps(fps);

    // Mild enhancement
    if (enhance) {
      // Chain with existing filters if present
      const enh = "eq=brightness=0.02:contrast=1.08:gamma=1.04";
      // If filters already exist, append; else set
      const existing = cmd._currentOutput.videoFilters || [];
      if (existing.length > 0) {
        cmd.videoFilters(
          [...existing.map((f) => f.filter || f), enh].join(",")
        );
      } else {
        cmd.videoFilters(enh);
      }
    }

    cmd
      .on("end", () => resolve(outputPath))
      .on("error", (err) => reject(new Error(`FFmpeg failed: ${err.message}`)))
      .save(outputPath);
  });
}

module.exports = { transcodeVideo };
