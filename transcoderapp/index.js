require("dotenv").config();

const { loadSecrets } = require("./bootstrap/secrets");

(async () => {
  // 1️⃣ Load AWS Secrets Manager values into process.env FIRST
  await loadSecrets({
    id: process.env.SECRET_ID || "n11070315-assignment2-transcoder",
  });

  console.log("[startup] Loaded environment variables:", {
    JOBS_TABLE: process.env.JOBS_TABLE,
    QUEUE_URL: process.env.QUEUE_URL?.slice(0, 50) + "...",
    AWS_REGION: process.env.AWS_REGION,
  });

  // 2️⃣ Now require everything that depends on env vars
  const express = require("express");
  const fileUpload = require("express-fileupload");
  const path = require("path");
  const fs = require("fs");

  // Cognito helpers
  const {
    signUp,
    confirmSignUp,
    login: cognitoLogin,
    authenticateCognito,
  } = require("./auth/cognito");

  // ✅ Routes are imported *after* secrets are loaded
  const adminRoutes = require("./routes/admin");
  const videoRoutes = require("./routes/videos");

  const app = express();
  app.set("trust proxy", true);

  const PORT = Number(process.env.PORT || 3000);
  const HOST = process.env.HOST || "0.0.0.0";
  const PUBLIC_URL =
    process.env.PUBLIC_URL ||
    (process.env.DOMAIN
      ? `http://${process.env.DOMAIN}`
      : `http://localhost:${PORT}`);

  // Ensure local data dirs exist
  const DATA_DIR = path.join(__dirname, "data");
  const TMP_DIR = path.join(DATA_DIR, "tmp");
  const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
  const PROCESSED_DIR = path.join(DATA_DIR, "processed");
  fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  fs.mkdirSync(PROCESSED_DIR, { recursive: true });

  // Static assets
  app.use(express.static(path.join(__dirname, "public")));

  // File uploads
  app.use(
    fileUpload({
      createParentPath: true,
      useTempFiles: true,
      tempFileDir: TMP_DIR,
      limits: { fileSize: 1024 * 1024 * 1024 },
      abortOnLimit: true,
      debug: false,
    })
  );

  // Routes
  app.use("/admin", adminRoutes);
  app.get("/health", (_req, res) => res.json({ ok: true }));

  // AUTH (Cognito)
  app.post("/auth/sign-up", express.json(), async (req, res) => {
    try {
      const { username, email, password } = req.body || {};
      if (!username || !email || !password)
        return res
          .status(400)
          .json({ error: "username, email, password required" });
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
      if (!username || !code)
        return res.status(400).json({ error: "username and code required" });
      await confirmSignUp({ username, code });
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) });
    }
  });

  app.post("/auth/login", express.json(), async (req, res) => {
    try {
      const { username, password } = req.body || {};
      if (!username || !password)
        return res
          .status(400)
          .json({ error: "username and password required" });
      const tokens = await cognitoLogin({ username, password });
      return res.json({ username, authToken: tokens.idToken, ...tokens });
    } catch (e) {
      console.error("Cognito login failed:", e.name, e.message);
      const code = e.name || "AuthError";
      const status = code === "UserNotConfirmedException" ? 403 : 401;
      return res.status(status).json({ error: code, message: e.message });
    }
  });

  app.get("/auth/me", authenticateCognito, (req, res) => {
    const groups = req.user["cognito:groups"] || [];
    const username =
      req.user["cognito:username"] || req.user.username || req.user.email;
    res.json({
      sub: req.user.sub,
      username,
      email: req.user.email,
      groups,
      isAdmin: groups.map((g) => String(g).toLowerCase()).includes("admin"),
    });
  });

  // Protected routes
  app.use(
    "/videos",
    authenticateCognito,
    express.json(),
    express.urlencoded({ extended: true }),
    videoRoutes
  );

  // SPA fallback
  app.use((req, res, next) => {
    if (req.method !== "GET") return next();
    res.sendFile(path.join(__dirname, "public", "index.html"));
  });

  // Start server
  const server = app.listen(PORT, HOST, () => {
    console.log("DATA dirs:", {
      data: DATA_DIR,
      tmp: TMP_DIR,
      uploads: UPLOADS_DIR,
      processed: PROCESSED_DIR,
    });
    console.log(`Server listening on ${HOST}:${PORT}`);
    console.log(`Public URL: ${PUBLIC_URL}`);
    console.log(`Health: ${PUBLIC_URL}/health`);
  });

  server.on("error", (err) => {
    console.error("Server error:", err.message);
    process.exitCode = 1;
  });

  process.on("SIGTERM", () => server.close(() => process.exit(0)));
  process.on("SIGINT", () => server.close(() => process.exit(0)));
})().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
