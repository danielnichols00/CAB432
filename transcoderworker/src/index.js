// transcoderworker/src/index.js
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { pipeline } = require("stream/promises");
const {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
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

const { transcodeVideo } = require("./transcode");

// --- Env ---
const REGION = process.env.AWS_REGION || "ap-southeast-2";
const QUEUE_URL = process.env.QUEUE_URL;
const BUCKET = process.env.S3_BUCKET_NAME;
const JOBS_TABLE =
  process.env.JOBS_TABLE || process.env.TABLE_NAME || "transcoder-jobs";
const WAIT_TIME = Number(process.env.SQS_WAIT_SECONDS || 20);
const VISIBILITY = Number(process.env.SQS_VISIBILITY || 300);
const WORKER_CONCURRENCY = Number(process.env.WORKER_CONCURRENCY || 2);
const BATCH_SIZE = Math.min(Number(process.env.SQS_MAX_MESSAGES || 10), 10);
const PARALLEL_VARIANTS =
  String(process.env.WORKER_PARALLEL_VARIANTS || "false").toLowerCase() ===
  "true";
const HEARTBEAT_SECONDS = Number(process.env.WORKER_HEARTBEAT_SECONDS || 60);

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

function startHeartbeat(receiptHandle) {
  if (!HEARTBEAT_SECONDS || HEARTBEAT_SECONDS <= 0) return null;
  let cancelled = false;

  const tick = async () => {
    if (cancelled) return;
    try {
      await sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: QUEUE_URL,
          ReceiptHandle: receiptHandle,
          VisibilityTimeout: VISIBILITY,
        })
      );
      // console.log("[worker] visibility extended");
    } catch (e) {
      console.warn("[worker] heartbeat failed:", e?.message || e);
    }
    if (!cancelled) {
      timer = setTimeout(tick, HEARTBEAT_SECONDS * 1000);
    }
  };

  let timer = setTimeout(tick, HEARTBEAT_SECONDS * 1000);

  return () => {
    cancelled = true;
    clearTimeout(timer);
  };
}

async function processMessage(msg) {
  const body = JSON.parse(msg.Body);
  const {
    jobId,
    owner,
    inputKey,
    targetProfiles = ["source"],
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
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: inputKey }));
  } catch {
    console.error("[worker] S3 key missing:", {
      bucket: BUCKET,
      key: inputKey,
    });
    await failJob(jobId, "INPUT_NOT_FOUND");
    return;
  }

  // Use the original extension to keep things sane for non-mp4 inputs
  const originalName = path.basename(inputKey);
  const baseName = path.parse(originalName).name;
  const ext = path.extname(originalName) || ".bin";
  const localIn = `/tmp/${baseName}${ext}`;

  try {
    await downloadToTmp(BUCKET, inputKey, localIn);
  } catch (err) {
    console.error("[worker] download failed:", err?.message || err);
    await failJob(jobId, "DOWNLOAD_FAILED");
    return;
  }

  const stopHeartbeat = startHeartbeat(msg.ReceiptHandle);
  const outputs = [];

  const doOneVariant = async (profile) => {
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
  };

  try {
    if (PARALLEL_VARIANTS && targetProfiles.length > 1) {
      await Promise.all(targetProfiles.map((p) => doOneVariant(p)));
    } else {
      for (const p of targetProfiles) {
        await doOneVariant(p);
      }
    }
  } catch (err) {
    console.error("[worker] transcode/upload failed:", err?.message || err);
    await failJob(jobId, "TRANSCODE_FAILED");
    stopHeartbeat && stopHeartbeat();
    fs.rmSync(localIn, { force: true });
    return;
  }

  stopHeartbeat && stopHeartbeat();
  fs.rmSync(localIn, { force: true });

  await markJob(jobId, {
    status: "COMPLETED",
    outputs,
    finishedAt: new Date().toISOString(),
  });
}

// Simple in-process semaphore for per-instance concurrency
let active = 0;
const queue = [];
function runWithLimit(fn) {
  return new Promise((resolve, reject) => {
    const task = async () => {
      active++;
      try {
        const result = await fn();
        resolve(result);
      } catch (e) {
        reject(e);
      } finally {
        active--;
        if (queue.length) queue.shift()();
      }
    };
    if (active < WORKER_CONCURRENCY) task();
    else queue.push(task);
  });
}

async function consumeBatch() {
  const { Messages } = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: QUEUE_URL,
      MaxNumberOfMessages: BATCH_SIZE, // up to 10
      WaitTimeSeconds: WAIT_TIME,
      VisibilityTimeout: VISIBILITY,
    })
  );
  if (!Messages || Messages.length === 0) return;

  await Promise.all(
    Messages.map((m) =>
      runWithLimit(async () => {
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
          // Do not delete the message -> let it become visible after timeout
        }
      })
    )
  );
}

async function loop() {
  console.log("[transcoderworker] polling:", QUEUE_URL, {
    concurrency: WORKER_CONCURRENCY,
    batch: BATCH_SIZE,
    visibility: VISIBILITY,
    heartbeat: HEARTBEAT_SECONDS,
    parallelVariants: PARALLEL_VARIANTS,
  });
  while (true) {
    try {
      await consumeBatch();
    } catch (e) {
      console.error("[transcoderworker] poll error:", e?.message || e);
      await new Promise((r) => setTimeout(r, 2000)); // brief backoff
    }
  }
}

loop().catch((e) => {
  console.error("[transcoderworker] fatal:", e);
  process.exit(1);
});
