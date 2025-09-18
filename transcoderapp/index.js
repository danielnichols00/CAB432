// index.js
require("dotenv").config();

const express = require("express");
const fileUpload = require("express-fileupload");
const path = require("path");

// ✅ NEW: Cognito helpers
const {
  signUp,
  confirmSignUp,
  login: cognitoLogin,
  authenticateCognito,
} = require("./auth/cognito");

const videoRoutes = require("./routes/videos");

const app = express();
const PORT = process.env.PORT || 3000;

// ---- Static assets (homepage/CSS/JS) ----
app.use(express.static(path.join(__dirname, "public")));

// ---- File uploads: BEFORE routes; temp files + sane limits ----
app.use(
  fileUpload({
    createParentPath: true,
    useTempFiles: true,
    tempFileDir: path.join(__dirname, "data", "tmp"),
    limits: { fileSize: 1024 * 1024 * 1024 }, // 1 GB
    abortOnLimit: true,
    debug: false,
  })
);

// ---- Health ----
app.get("/health", (_req, res) => res.json({ ok: true }));

// ---- AUTH (Cognito) ----
app.post("/auth/sign-up", express.json(), async (req, res) => {
  try {
    const { username, email, password } = req.body || {};
    if (!username || !email || !password) {
      return res
        .status(400)
        .json({ error: "username, email, password required" });
    }
    await signUp({ username, email, password });
    res.json({
      ok: true,
      message: "Check your email for the confirmation code.",
    });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.post("/auth/confirm", express.json(), async (req, res) => {
  try {
    const { username, code } = req.body || {};
    if (!username || !code) {
      return res.status(400).json({ error: "username and code required" });
    }
    await confirmSignUp({ username, code });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

// index.js
app.post("/auth/login", express.json(), async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: "username and password required" });
    }
    const tokens = await cognitoLogin({ username, password });
    return res.json({ username, authToken: tokens.idToken, ...tokens });
  } catch (e) {
    console.error("Cognito login failed:", e.name, e.message);
    // TEMP: expose e.name to help diagnose; tighten later
    const code = (e && e.name) || "AuthError";
    const status = code === "UserNotConfirmedException" ? 403 : 401;
    return res.status(status).json({ error: code, message: e.message });
  }
});

// Optional: whoami
app.get("/auth/me", authenticateCognito, (req, res) => {
  res.json({
    sub: req.user.sub,
    email: req.user.email,
    groups: req.user["cognito:groups"] || [],
  });
});

// ---- Protected API (JSON parsers here won't affect multipart uploads) ----
app.use(
  "/videos",
  authenticateCognito, // ✅ Cognito-protected
  express.json(),
  express.urlencoded({ extended: true }),
  videoRoutes
);

// ---- SPA fallback for GETs only (Express 5 safe) ----
app.use((req, res, next) => {
  if (req.method !== "GET") return next();
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ---- Start server ----
app.listen(PORT, () => {
  console.log("DATA dirs:", {
    data: path.join(__dirname, "data"),
    tmp: path.join(__dirname, "data", "tmp"),
    uploads: path.join(__dirname, "data", "uploads"),
    processed: path.join(__dirname, "data", "processed"),
  });
  console.log(`Server running on http://localhost:${PORT}`);
});
