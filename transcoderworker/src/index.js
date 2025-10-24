// transcoderworker/src/index.js
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { pipeline } = require("stream/promises");
const {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} = require("@aws-sdk/client-sqs");
const {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
} = require("@aws-sdk/client-s3");
const { NodeHttpHandler } = require("@smithy/node-http-handler");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");

const { transcodeVideo } = require("../../transcoderapp/workers/transcode");

// --- Env ---
const REGION = process.env.AWS_REGION || "ap-southeast-2";
const QUEUE_URL = process.env.QUEUE_URL;
const BUCKET = process.env.S3_BUCKET_NAME;
const JOBS_TABLE =
  process.env.JOBS_TABLE || process.env.TABLE_NAME || "transcoder-jobs";
const WAIT_TIME = Number(process.env.SQS_WAIT_SECONDS || 20);
const VISIBILITY = Number(process.env.SQS_VISIBILITY || 300);

if (!QUEUE_URL || !BUCKET) {
  console.error("Missing required env: QUEUE_URL and S3_BUCKET_NAME");
  process.exit(1);
}

// --- AWS clients ---
const s3 = new S3Client({
  region: REGION,
  requestHandler: new NodeHttpHandler({
    connectionTimeout: 30_000,
    socketTimeout: 300_000,
  }),
});
const sqs = new SQSClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

// --- helpers ---
async function downloadToTmp(bucket, key, outPath) {
  console.log("[worker] fetching from S3:", { bucket, key, outPath });
  const resp = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: key })
  );

  if (resp.Body && typeof resp.Body.transformToByteArray === "function") {
    const bytes = await resp.Body.transformToByteArray();
    await fs.promises.writeFile(outPath, Buffer.from(bytes));
  } else {
    await pipeline(resp.Body, fs.createWriteStream(outPath));
  }
}

async function uploadFromPath(
  bucket,
  key,
  filePath,
  contentType,
  metadata = {}
) {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: fs.createReadStream(filePath),
      ContentType: contentType || "video/mp4",
      CacheControl: "public, max-age=31536000",
      Metadata: metadata,
    })
  );
}

function mapProfileToOptions(profile, base) {
  const o = { ...base };
  if (profile === "1080p") o.scale = "1080p";
  else if (profile === "720p") o.scale = "720p";
  else o.scale = "source";
  return o;
}

async function markJob(jobId, attrs) {
  const expr = [];
  const names = {};
  const values = {};
  let i = 0;
  for (const [k, v] of Object.entries(attrs)) {
    const nk = `#n${i}`;
    const vk = `:v${i}`;
    names[nk] = k;
    values[vk] = v;
    expr.push(`${nk} = ${vk}`);
    i++;
  }
  await ddb.send(
    new UpdateCommand({
      TableName: JOBS_TABLE,
      Key: { jobId },
      UpdateExpression: `SET ${expr.join(", ")}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    })
  );
}

async function failJob(jobId, message) {
  try {
    await markJob(jobId, {
      status: "FAILED",
      error: String(message || "unknown"),
      failedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error("[worker] failed to mark job FAILED:", e?.message || e);
  }
}

async function processMessage(msg) {
  const body = JSON.parse(msg.Body);
  const {
    jobId,
    owner,
    inputKey,
    targetProfiles = ["source", scale], // single variant by default
    format = "mp4",
    preset = "medium",
    scale = "source",
    fps = "source",
    enhance = false,
  } = body;

  console.log("[worker] Starting job", { jobId, inputKey, owner });

  await markJob(jobId, {
    status: "PROCESSING",
    startedAt: new Date().toISOString(),
  });

  fs.mkdirSync("/tmp", { recursive: true });

  // Confirm the object exists before trying to fetch
  try {
    console.log("[worker] Checking S3 key exists", {
      bucket: BUCKET,
      key: inputKey,
    });
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: inputKey }));
  } catch {
    console.error("[worker] S3 key missing:", {
      bucket: BUCKET,
      key: inputKey,
    });
    await failJob(jobId, "INPUT_NOT_FOUND");
    return;
  }

  // Get original base name for clean filenames
  const originalName = path.basename(inputKey); // e.g. '1761267002318_Clip_of_World.mp4'
  const baseName = path.parse(originalName).name; // no extension

  const localIn = `/tmp/${baseName}.mp4`;

  try {
    await downloadToTmp(BUCKET, inputKey, localIn);
  } catch (err) {
    console.error("[worker] download failed:", err?.message || err);
    await failJob(jobId, "DOWNLOAD_FAILED");
    return;
  }

  const outputs = [];

  for (const profile of targetProfiles) {
    try {
      const opts = mapProfileToOptions(profile, {
        format,
        preset,
        scale,
        fps,
        enhance,
      });

      const outPath = await transcodeVideo(localIn, opts);
      const variant = [
        preset,
        opts.scale,
        fps === "source" ? "src" : `${fps}fps`,
        enhance ? "enh" : null,
      ]
        .filter(Boolean)
        .join("_");
      const outName = `${baseName}_${variant}.${opts.format}`;
      const outKey = `processed/${owner}/${outName}`;

      await uploadFromPath(
        BUCKET,
        outKey,
        outPath,
        `video/${opts.format || "mp4"}`,
        { jobid: jobId, original: inputKey }
      );

      outputs.push({ profile, key: outKey, name: outName });

      fs.rmSync(outPath, { force: true });
    } catch (err) {
      console.error("[worker] transcode/upload failed:", err?.message || err);
      await failJob(jobId, "TRANSCODE_FAILED");
      return;
    }
  }

  fs.rmSync(localIn, { force: true });

  await markJob(jobId, {
    status: "COMPLETED",
    outputs,
    finishedAt: new Date().toISOString(),
  });
}

async function loop() {
  console.log("[transcoderworker] polling:", QUEUE_URL);
  while (true) {
    const { Messages } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: QUEUE_URL,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: WAIT_TIME,
        VisibilityTimeout: VISIBILITY,
      })
    );
    if (!Messages || Messages.length === 0) continue;

    for (const m of Messages) {
      try {
        await processMessage(m);
        await sqs.send(
          new DeleteMessageCommand({
            QueueUrl: QUEUE_URL,
            ReceiptHandle: m.ReceiptHandle,
          })
        );
      } catch (err) {
        console.error("[transcoderworker] job failed:", err?.message || err);
        try {
          const body = JSON.parse(m.Body || "{}");
          if (body.jobId) await failJob(body.jobId, err?.message || err);
        } catch {}
      }
    }
  }
}

loop().catch((e) => {
  console.error("[transcoderworker] fatal:", e);
  process.exit(1);
});
