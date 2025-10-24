// transcoderapp/routes/admin.js
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

const REGION = process.env.AWS_REGION || "ap-southeast-2";
const JOBS_TABLE = process.env.JOBS_TABLE || "n11070315-transcode-jobs";
const QUEUE_URL = process.env.QUEUE_URL; // required for /retry-job

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const sqs = new SQSClient({ region: REGION });

/** Decode JWT payload without verification (for UI-only gating). */
function decodeJwtPayloadUnsafe(authHeader) {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice("Bearer ".length).trim();
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const json = Buffer.from(parts[1], "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** Normalize groups from multiple possible claims. */
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
 * - If req.user is missing, try to backfill from Authorization header (same token your frontend stores).
 * - Then enforce admin group membership.
 */
router.use((req, res, next) => {
  // Backfill req.user if middleware didn't populate it
  if (!req.user) {
    const decoded = decodeJwtPayloadUnsafe(req.headers.authorization);
    if (decoded) req.user = decoded;
  }

  // Optional: log once per request to debug what the router sees
  // console.log("[/admin] req.user snapshot:", {
  //   sub: req.user?.sub,
  //   username: req.user?.["cognito:username"] || req.user?.username,
  //   groups: req.user ? extractGroups(req.user) : []
  // });

  if (!isAdminReq(req)) {
    return res.status(403).json({ error: "Admin only" });
  }
  next();
});

// GET /admin/jobs — list all jobs (optionally filter by status)
router.get("/jobs", async (req, res) => {
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

// POST /admin/retry-job — resend FAILED job to SQS and mark original as RETRIED
router.post("/retry-job", async (req, res) => {
  try {
    if (!QUEUE_URL) {
      return res.status(500).json({ error: "QUEUE_URL env not configured" });
    }
    const { jobId } = req.body || {};
    if (!jobId) return res.status(400).json({ error: "Missing jobId" });

    // Load the original job
    const { Item: job } = await ddb.send(
      new GetCommand({ TableName: JOBS_TABLE, Key: { jobId } })
    );
    if (!job) return res.status(404).json({ error: "Job not found" });
    if (String(job.status).toUpperCase() !== "FAILED") {
      return res.status(400).json({ error: "Only FAILED jobs can be retried" });
    }

    // New job id (traceable to original)
    const newJobId = `retry-${Date.now()}-${String(jobId).slice(0, 8)}`;

    // Enqueue the same work again
    const payload = {
      jobId: newJobId,
      owner: job.owner,
      inputKey: job.inputKey,
      format: job.format || "mp4",
      preset: job.preset || "medium",
      scale: job.scale || "source",
      fps: job.fps || "source",
      enhance: !!job.enhance,
      targetProfiles: Array.isArray(job.targetProfiles)
        ? job.targetProfiles
        : ["source"],
      requestedAt: new Date().toISOString(),
      retriedFrom: jobId,
    };

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: QUEUE_URL,
        MessageBody: JSON.stringify(payload),
      })
    );

    // Mark old job as RETRIED + link to follow-up job
    await ddb.send(
      new UpdateCommand({
        TableName: JOBS_TABLE,
        Key: { jobId },
        UpdateExpression:
          "SET #s = :s, #r = if_not_exists(#r, :zero) + :one, #n = :n, #t = :t, #f = :f",
        ExpressionAttributeNames: {
          "#s": "status",
          "#r": "retryCount",
          "#n": "note",
          "#t": "retriedAt",
          "#f": "followupJobId",
        },
        ExpressionAttributeValues: {
          ":s": "RETRIED",
          ":zero": 0,
          ":one": 1,
          ":n": `Retried as ${newJobId}`,
          ":t": new Date().toISOString(),
          ":f": newJobId,
        },
      })
    );

    res.json({ ok: true, newJobId });
  } catch (err) {
    console.error("[admin/retry-job] error:", err);
    res.status(500).json({ error: err.message || "Retry failed" });
  }
});

module.exports = router;
