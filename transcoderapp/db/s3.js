// s3.js
require("dotenv").config();
const path = require("path");
const {
  S3Client,
  CreateBucketCommand,
  PutBucketTaggingCommand,
  PutObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const region = process.env.AWS_REGION || "ap-southeast-2";
const bucketName = process.env.S3_BUCKET_NAME || "n11713739-bucket";
const qutUsername = process.env.QUT_USERNAME || "n11713739@qut.edu.au";
const purpose = process.env.PURPOSE || "prac";

const s3Client = new S3Client({ region });

// ---------- Helpers ----------
function guessContentType(objectKey, fallback) {
  if (fallback) return fallback;
  const ext = path.extname(objectKey).toLowerCase();
  switch (ext) {
    case ".mp4":
      return "video/mp4";
    case ".webm":
      return "video/webm";
    case ".avi":
      return "video/x-msvideo";
    case ".mov":
      return "video/quicktime";
    case ".mkv":
      return "video/x-matroska";
    default:
      return "application/octet-stream";
  }
}

function toUserMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") return undefined;
  const meta = {};
  for (const [k, v] of Object.entries(metadata)) {
    if (v === undefined || v === null) continue;
    meta[String(k).toLowerCase()] = String(v);
  }
  return Object.keys(meta).length ? meta : undefined;
}

// ---------- Bucket Ops ----------
async function bucketExists() {
  try {
    await s3Client.send(new HeadBucketCommand({ Bucket: bucketName }));
    return true;
  } catch {
    return false;
  }
}

async function createBucket() {
  try {
    const input = { Bucket: bucketName };
    if (region !== "us-east-1") {
      input.CreateBucketConfiguration = { LocationConstraint: region };
    }
    const resp = await s3Client.send(new CreateBucketCommand(input));
    console.log("[S3] Bucket created:", resp.Location || bucketName);
  } catch (err) {
    console.log("[S3] Create bucket error:", err.name || err.message);
  }
}

async function tagBucket() {
  try {
    const resp = await s3Client.send(
      new PutBucketTaggingCommand({
        Bucket: bucketName,
        Tagging: {
          TagSet: [
            { Key: "qut-username", Value: qutUsername },
            { Key: "purpose", Value: purpose },
          ],
        },
      })
    );
    console.log("[S3] Tag bucket http:", resp.$metadata?.httpStatusCode);
  } catch (err) {
    console.log("[S3] Tag bucket error:", err.name || err.message);
  }
}

// ---------- Object Ops ----------
/**
 * Upload object to S3.
 * @param {string} objectKey
 * @param {Buffer|string|Uint8Array|Readable} body
 * @param {string} [contentType]
 * @param {Record<string,string>} [metadata] - stored as x-amz-meta-*
 */
async function putObject(objectKey, body, contentType, metadata) {
  try {
    // Normalize body to a Buffer where possible (streams are also fine)
    const buf = Buffer.isBuffer(body)
      ? body
      : typeof body === "string"
      ? Buffer.from(body)
      : body;

    const ct = guessContentType(objectKey, contentType);
    const meta = toUserMetadata(metadata);

    const resp = await s3Client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: objectKey,
        Body: buf,
        ContentType: ct,
        ...(Buffer.isBuffer(buf) ? { ContentLength: buf.length } : {}),
        ...(meta ? { Metadata: meta } : {}),
      })
    );

    console.log("[S3] PutObject ok:", objectKey, {
      ct,
      bytes: Buffer.isBuffer(buf) ? buf.length : undefined,
      meta: meta ? Object.keys(meta) : [],
    });
    return resp;
  } catch (err) {
    console.error("[S3] PutObject failed:", objectKey, err.name || err.message);
    throw err;
  }
}

/**
 * Get object from S3.
 * @param {string} objectKey
 * @param {boolean} asBuffer - when true, returns Buffer; otherwise returns string.
 */
async function getObject(objectKey, asBuffer = false) {
  try {
    const resp = await s3Client.send(
      new GetObjectCommand({ Bucket: bucketName, Key: objectKey })
    );

    if (asBuffer) {
      const bytes = await resp.Body.transformToByteArray();
      return Buffer.from(bytes);
    }
    // Text mode (caller expects string); do not log the contents.
    return await resp.Body.transformToString();
  } catch (err) {
    console.log("[S3] GetObject error:", objectKey, err.name || err.message);
    throw err;
  }
}

/**
 * Generate a time-limited GET URL.
 * @param {string} objectKey
 * @param {number} expiresIn seconds
 */
async function getPresignedUrl(objectKey, expiresIn = 3600) {
  try {
    const cmd = new GetObjectCommand({ Bucket: bucketName, Key: objectKey });
    const url = await getSignedUrl(s3Client, cmd, { expiresIn });
    console.log("[S3] Presigned URL ok for:", objectKey);
    return url;
  } catch (err) {
    console.log(
      "[S3] Presigned URL error:",
      objectKey,
      err.name || err.message
    );
    throw err;
  }
}

async function listByPrefix(prefix) {
  const out = [];
  let ContinuationToken = undefined;
  do {
    const resp = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: prefix,
        ContinuationToken,
      })
    );
    (resp.Contents || []).forEach((o) => out.push(o));
    ContinuationToken = resp.IsTruncated
      ? resp.NextContinuationToken
      : undefined;
  } while (ContinuationToken);
  return out;
}

module.exports = {
  bucketExists,
  createBucket,
  tagBucket,
  putObject,
  getObject,
  getPresignedUrl,
  listByPrefix,
};
