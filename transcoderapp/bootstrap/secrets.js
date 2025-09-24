// bootstrap/secrets.js
const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");

/**
 * Load a JSON secret from AWS Secrets Manager into process.env
 * so the rest of your code can just use process.env.FOO.
 *
 * @param {object} opts
 * @param {string} opts.id      Secret name or ARN (defaults to process.env.SECRET_ID)
 * @param {string} opts.region  AWS region (defaults to process.env.AWS_REGION or ap-southeast-2)
 * @param {boolean} opts.preserve  If true, do NOT overwrite existing env vars
 */
async function loadSecrets({
  id = process.env.SECRET_ID,
  region = process.env.AWS_REGION || "ap-southeast-2",
  preserve = false,
} = {}) {
  if (!id) {
    console.log("[secrets] SECRET_ID not set; skipping Secrets Manager load");
    return;
  }

  try {
    const client = new SecretsManagerClient({ region });
    const resp = await client.send(new GetSecretValueCommand({ SecretId: id }));

    const raw =
      resp.SecretString ||
      (resp.SecretBinary &&
        Buffer.from(resp.SecretBinary, "base64").toString("utf8")) ||
      "{}";

    let data = {};
    try {
      data = JSON.parse(raw);
    } catch {
      console.warn("[secrets] Secret is not JSON; skipping parse");
    }

    const keys = [];
    for (const [k, v] of Object.entries(data)) {
      if (preserve && process.env[k] != null) continue;
      process.env[k] = String(v);
      keys.push(k);
    }

    console.log(
      "[secrets] loaded keys:",
      keys.length ? keys.join(", ") : "(none)"
    );
  } catch (err) {
    console.warn("[secrets] load failed:", err.name || err.message);
    // app will continue using .env values
  }
}

module.exports = { loadSecrets };
