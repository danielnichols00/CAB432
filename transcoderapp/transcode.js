//TRANSCODE FILE - This file was highly assisted by GenAI (cries in JS/HTML/CSS) 

const ffmpeg = require("fluent-ffmpeg");
const path = require("path");


//Transcode video function - heavy acts as a flag for slower but better quality encoding at the expense of CPU usage
function transcodeVideo(inputPath, { format = "mp4", heavy = false } = {}) {
  return new Promise((resolve, reject) => {
    const base = path.parse(inputPath).name;
    const outDir = path.join(__dirname, "data", "processed"); //Designates file destinations
    const outputPath = path.join(outDir, `${base}.${format}`);

    const cmd = ffmpeg(inputPath);

    if (format === "mp4") {
      cmd.videoCodec("libx264").outputOptions([
        "-preset", heavy ? "veryslow" : "medium",
        "-crf", heavy ? "20" : "23",
        "-movflags", "+faststart"
      ]);
    } else if (format === "webm") {
      cmd.videoCodec("libvpx-vp9").outputOptions([
        "-b:v", "0",
        "-crf", heavy ? "28" : "32"
      ]);
    } else if (format === "avi") {
      cmd.videoCodec("mpeg4").outputOptions(["-qscale:v", heavy ? "2" : "4"]);
    } else {
      return reject(new Error(`Unsupported format: ${format}`));
    }

    //Code for higher quality video encoding
    if (heavy) {
      cmd.fps(60)
         .size("1920x1080")
         .videoFilters("eq=brightness=0.02:contrast=1.1:gamma=1.05");
    }

    cmd.on("end", () => resolve(outputPath))
       .on("error", (err) => reject(err))
       .save(outputPath);
  });
}

module.exports = { transcodeVideo };
