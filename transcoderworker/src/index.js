// transcoderworker/src/index.js
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} = require("@aws-sdk/client-sqs");
const {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand, // <-- added
} = require("@aws-sdk/client-s3");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  UpdateCommand,
  GetCommand,
} = require("@aws-sdk/lib-dynamodb");

// Reuse your existing transcoder
const { transcodeVideo } = require("../../transcoderapp/workers/transcode");

// --- Env ---
const REGION = process.env.AWS_REGION || "ap-southeast-2";
const QUEUE_URL = process.env.QUEUE_URL; // e.g. https://sqs.ap-southeast-2.amazonaws.com/<acct>/TranscoderJobs
const BUCKET = process.env.S3_BUCKET_NAME; // single S3 bucket for both uploads/ and processed/
const JOBS_TABLE =
  process.env.JOBS_TABLE || process.env.TABLE_NAME || "transcoder-jobs";
const WAIT_TIME = Number(process.env.SQS_WAIT_SECONDS || 20); // long poll
const VISIBILITY = Number(process.env.SQS_VISIBILITY || 300); // seconds

if (!QUEUE_URL || !BUCKET) {
  console.error("Missing required env: QUEUE_URL and S3_BUCKET_NAME");
  process.exit(1);
}

// --- AWS clients ---
const sqs = new SQSClient({ region: REGION });
const s3 = new S3Client({ region: REGION });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

// --- helpers ---
async function downloadToTmp(bucket, key, outPath) {
  console.log("[worker] fetching from S3:", { bucket, key, outPath });
  const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  await new Promise((resolve, reject) => {
    const w = fs.createWriteStream(outPath);
    obj.Body.pipe(w);
    obj.Body.on("error", reject);
    w.on("finish", resolve);
  });
}

async function uploadFromPath(bucket, key, filePath, contentType) {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: fs.createReadStream(filePath),
      ContentType: contentType || "video/mp4",
      CacheControl: "public, max-age=31536000",
    })
  );
}

function mapProfileToOptions(profile, base) {
  // Your transcodeVideo supports: format, preset, scale, fps, enhance
  const o = { ...base };
  if (profile === "1080p") o.scale = "1080p";
  else if (profile === "720p") o.scale = "720p";
  else if (profile === "source") o.scale = "source";
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

async function processMessage(msg) {
  const body = JSON.parse(msg.Body);
  // Expected shape from API:
  // { jobId, owner, inputKey, targetProfiles, requestedAt, format, preset, scale, fps, enhance }
  const {
    jobId,
    owner,
    inputKey,
    targetProfiles = ["720p", "source"],
    format = "mp4",
    preset = "medium",
    scale = "source",
    fps = "source",
    enhance = false,
  } = body;

  console.log("[worker] Starting job", { jobId, inputKey, owner });

  // Mark PROCESSING
  await markJob(jobId, {
    status: "PROCESSING",
    startedAt: new Date().toISOString(),
  });

  // Ensure /tmp
  try {
    fs.mkdirSync("/tmp", { recursive: true });
  } catch {}

  // Check the input key exists before trying to download
  const localIn = `/tmp/in-${jobId}.mp4`;
  try {
    console.log("[worker] Checking S3 key exists", {
      bucket: BUCKET,
      key: inputKey,
    });
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: inputKey }));
  } catch (e) {
    console.error("[worker] S3 key missing:", {
      bucket: BUCKET,
      key: inputKey,
    });
    await markJob(jobId, {
      status: "FAILED",
      error: "INPUT_NOT_FOUND",
      finishedAt: new Date().toISOString(),
    });
    return; // stop processing this message
  }

  // Download original (e.g., uploads/<owner>/<file>)
  await downloadToTmp(BUCKET, inputKey, localIn);

  const outputs = [];

  for (const profile of targetProfiles) {
    const opts = mapProfileToOptions(profile, {
      format,
      preset,
      scale,
      fps,
      enhance,
    });
    const outPath = await transcodeVideo(localIn, opts);
    const outName = path.basename(outPath);
    const outKey = `processed/${owner}/${outName}`; // write to processed/ prefix in same bucket

    await uploadFromPath(
      BUCKET,
      outKey,
      outPath,
      `video/${opts.format || "mp4"}`
    );
    outputs.push({ profile, key: outKey, name: outName });

    try {
      fs.rmSync(outPath, { force: true });
    } catch {}
  }

  try {
    fs.rmSync(localIn, { force: true });
  } catch {}

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
        // Do nothing: message becomes visible again; after maxReceiveCount it goes to DLQ
      }
    }
  }
}

loop().catch((e) => {
  console.error("[transcoderworker] fatal:", e);
  process.exit(1);
});
