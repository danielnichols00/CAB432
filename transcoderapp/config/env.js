// config/env.js
require("dotenv").config();

function rq(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

// Comma-separated list lets you rotate secrets without breaking old tokens.
// First = current signing key, rest = still-valid legacy keys.
const JWT_SECRETS = (process.env.JWT_SECRETS || "dev-secret-change-me")
  .split(",")
  .map((s) => s.trim());

module.exports = {
  NODE_ENV: process.env.NODE_ENV || "development",
  JWT_SECRETS,
  JWT_ISSUER: process.env.JWT_ISSUER || "transcoderapp",
  JWT_AUDIENCE: process.env.JWT_AUDIENCE || "transcoderapp-web",
  ACCESS_TTL: process.env.ACCESS_TTL || "30m",
  REFRESH_TTL: process.env.REFRESH_TTL || "7d",
};
