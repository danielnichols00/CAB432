const express = require("express");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  ScanCommand,
  GetCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");
const { SQSClient, SendMessageCommand } = require("@aws-sdk/client-sqs");

const router = express.Router();

/**
 * Helper to read AWS env vars dynamically at runtime
 * (important when using AWS Secrets Manager)
 */
function getEnv() {
  return {
    AWS_REGION: process.env.AWS_REGION || "ap-southeast-2",
    JOBS_TABLE: process.env.JOBS_TABLE || "n11070315-transcode-jobs",
    QUEUE_URL: process.env.QUEUE_URL || "",
  };
}

/**
 * Decode JWT payload (without signature verification)
 * Used for simple admin UI gating.
 */
function decodeJwtPayloadUnsafe(authHeader) {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice("Bearer ".length).trim();
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function extractGroups(user) {
  if (!user) return [];
  const g1 = user["cognito:groups"];
  const g2 = user.groups;
  const g3 = user["custom:groups"];
  const groups = Array.isArray(g1)
    ? g1
    : Array.isArray(g2)
    ? g2
    : Array.isArray(g3)
    ? g3
    : [];
  return groups.map((g) => String(g).toLowerCase());
}

function isAdminReq(req) {
  const groups = extractGroups(req.user);
  return groups.includes("admin");
}

/**
 * Admin gate for all /admin routes:
 * If req.user is missing, decode token manually.
 */
router.use((req, res, next) => {
  if (!req.user) {
    const decoded = decodeJwtPayloadUnsafe(req.headers.authorization);
    if (decoded) req.user = decoded;
  }

  if (!isAdminReq(req)) {
    return res.status(403).json({ error: "Admin only" });
  }
  next();
});

router.get("/jobs", async (req, res) => {
  const { AWS_REGION, JOBS_TABLE } = getEnv();
  const ddb = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: AWS_REGION })
  );

  try {
    const statusFilter = (req.query.status || "").toUpperCase().trim();
    const data = await ddb.send(new ScanCommand({ TableName: JOBS_TABLE }));
    let items = Array.isArray(data.Items) ? data.Items : [];

    if (statusFilter) {
      items = items.filter(
        (j) => String(j.status || "").toUpperCase() === statusFilter
      );
    }

    items.sort(
      (a, b) =>
        new Date(b.startedAt || b.requestedAt || 0) -
        new Date(a.startedAt || a.requestedAt || 0)
    );

    res.json({ ok: true, items });
  } catch (err) {
    console.error("[admin/jobs] error:", err);
    res
      .status(500)
      .json({ ok: false, items: [], error: "Failed to load jobs" });
  }
});

// POST /admin/retry-job — requeue failed job

router.post("/retry-job", async (req, res) => {
  const { AWS_REGION, JOBS_TABLE, QUEUE_URL } = getEnv();
  const ddb = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: AWS_REGION })
  );
  const sqs = new SQSClient({ region: AWS_REGION });

  // Normalize jobId from body, query, or params; accept jobId/jobID/id casing
  const body = req.body || {};
  const jobId =
    body.jobId ||
    body.jobID ||
    body.id ||
    req.query.jobId ||
    req.query.jobID ||
    req.query.id ||
    req.params.jobId ||
    req.params.jobID ||
    req.params.id;

  if (!QUEUE_URL) {
    return res.status(500).json({ error: "QUEUE_URL env not configured" });
  }
  if (!jobId) {
    console.warn("[admin/retry-job] missing jobId. Received:", {
      headers: req.headers["content-type"],
      bodyKeys: Object.keys(body || {}),
      query: req.query,
      params: req.params,
    });
    return res.status(400).json({ error: "Missing jobId" });
  }

  try {
    // Load parent job
    const { Item: job } = await ddb.send(
      new GetCommand({ TableName: JOBS_TABLE, Key: { jobId } })
    );
    if (!job) return res.status(404).json({ error: "Job not found" });

    // pick profiles
    const profiles =
      Array.isArray(job.requestedProfiles) && job.requestedProfiles.length
        ? job.requestedProfiles
        : Array.isArray(job.targetProfiles) && job.targetProfiles.length
        ? job.targetProfiles
        : ["source"];

    // reset counters & mark QUEUED
    await ddb.send(
      new UpdateCommand({
        TableName: JOBS_TABLE,
        Key: { jobId },
        UpdateExpression:
          "SET #s = :queued, completedVariants = :z, outputs = :empty, " +
          "retryCount = if_not_exists(retryCount, :z) + :one, retriedAt = :t, note = :note",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":queued": "QUEUED",
          ":z": 0,
          ":one": 1,
          ":empty": [],
          ":t": new Date().toISOString(),
          ":note": `Admin retried ${profiles.length} variant(s)`,
        },
      })
    );

    // enqueue one message per variant
    const isFifo = String(QUEUE_URL).endsWith(".fifo");
    const sendVariant = async (variant) => {
      const payload = {
        jobId: job.jobId,
        owner: job.owner,
        inputKey: job.inputKey,
        targetProfiles: [variant],
        format: job.format || "mp4",
        preset: job.preset || "medium",
        scale: job.scale || "source",
        fps: job.fps || "source",
        enhance: !!job.enhance,
        variant,
        parentMode: "split-variants",
        requestedAt: new Date().toISOString(),
        retriedFrom: jobId,
      };

      const params = {
        QueueUrl: QUEUE_URL,
        MessageBody: JSON.stringify(payload),
      };

      if (isFifo) {
        // per-variant group to avoid head-of-line blocking
        params.MessageGroupId = `${job.jobId}-${variant}`;
        params.MessageDeduplicationId = `${job.jobId}-${variant}-${Date.now()}`;
      }

      await sqs.send(new SendMessageCommand(params));
    };

    await Promise.all(profiles.map(sendVariant));

    res.json({ ok: true, jobId, newJobId: jobId, variantsEnqueued: profiles });
  } catch (err) {
    console.error("[admin/retry-job] error:", err);
    res.status(500).json({ error: err.message || "Retry failed" });
  }
});

module.exports = router;
