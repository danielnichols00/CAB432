// auth/jwt.js
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const {
  JWT_SECRETS,
  JWT_ISSUER,
  JWT_AUDIENCE,
  ACCESS_TTL,
  REFRESH_TTL,
} = require("../config/env");

// HELPERS
const currentSecret = () => JWT_SECRETS[0];
const allSecrets = () => JWT_SECRETS;

// Minimal user projection we’ll attach to req.user
function toUser(payload) {
  return {
    sub: payload.sub,
    username: payload.username,
    roles: payload.roles || [],
    ver: payload.ver, // optional versioning (for rotation/invalidations)
  };
}

// SIGNERS
function signAccessToken({ sub, username, roles = [], ver }) {
  if (!sub) sub = username; // fallback
  const jti = crypto.randomUUID();
  const payload = { sub, username, roles, ver, typ: "access" };
  return jwt.sign(payload, currentSecret(), {
    algorithm: "HS256",
    expiresIn: ACCESS_TTL,
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    jwtid: jti,
  });
}

function signRefreshToken({ sub, username, ver }) {
  const jti = crypto.randomUUID();
  const payload = { sub: sub || username, username, ver, typ: "refresh" };
  return jwt.sign(payload, currentSecret(), {
    algorithm: "HS256",
    expiresIn: REFRESH_TTL,
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    jwtid: jti,
  });
}

// Rotate-friendly verify: try all known secrets (first is current).
function verifyToken(token) {
  let lastErr;
  for (const sec of allSecrets()) {
    try {
      return jwt.verify(token, sec, {
        algorithms: ["HS256"],
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
      });
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

// MIDDLEWARE
function authenticateAccess(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) {
    res.setHeader("WWW-Authenticate", 'Bearer realm="transcoderapp"');
    return res.sendStatus(401);
  }
  try {
    const payload = verifyToken(token);
    if (payload.typ !== "access") return res.sendStatus(401);
    req.auth = payload; // full claims if you need them
    req.user = toUser(payload);
    // console.log(`authToken verified for user: ${req.user.username} at URL ${req.url}`);
    next();
  } catch (err) {
    // console.log('JWT verification failed', err.name, err.message);
    res.setHeader("WWW-Authenticate", 'Bearer error="invalid_token"');
    return res.sendStatus(401);
  }
}

// ---- High-level helpers ----
function issueTokensForUser(user) {
  // user: { username, roles?, ver?, sub? }
  const accessToken = signAccessToken(user);
  const refreshToken = signRefreshToken(user);
  return {
    accessToken,
    refreshToken,
    tokenType: "Bearer",
    expiresIn: ACCESS_TTL,
  };
}

// Basic refresh flow (you can add DB checks for token version/blacklist if needed)
function refreshTokens(refreshToken) {
  const payload = verifyToken(refreshToken);
  if (payload.typ !== "refresh") {
    const err = new Error("Not a refresh token");
    err.code = "BAD_TOKEN_TYPE";
    throw err;
  }
  const { sub, username, ver, roles } = payload;
  return issueTokensForUser({ sub, username, ver, roles });
}

module.exports = {
  authenticateAccess,
  issueTokensForUser,
  refreshTokens,
  signAccessToken,
  signRefreshToken,
  verifyToken,
};
