// index.js
// INDEX FILE - Parts of code copied from tutorials, some generative AI used for troubleshooting and bug fixes
const express = require("express");
const fileUpload = require("express-fileupload");
const path = require("path");

const JWT = require("./jwt");
const videoRoutes = require("./routes/videos");

const app = express();
const PORT = process.env.PORT || 3000;

// --- Demo users (CAB432 tutorial style) ---
const users = {
  CAB432: { password: "supersecret", admin: false },
  admin: { password: "admin", admin: true },
};

// --- Middleware ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(fileUpload());

// Serve static assets (homepage, CSS, client JS)
app.use(express.static(path.join(__dirname, "public")));

// --- Auth endpoints ---
app.post("/auth/login", (req, res) => {
  const { username, password } = req.body || {};
  const user = users[username];
  if (!user || password !== user.password) return res.sendStatus(401);
  const token = JWT.generateAccessToken({ username });
  return res.json({ authToken: token, username });
});

app.get("/admin", JWT.authenticateToken, (req, res) => {
  const user = users[req.user.username];
  if (!user || !user.admin) return res.sendStatus(403);
  return res.json({ message: "Admin only content." });
});

// --- Protected routes ---
app.use("/videos", JWT.authenticateToken, videoRoutes);

// Serve index.html for any GET that wasn't handled above (SPA-style)
app.use((req, res, next) => {
  if (req.method !== "GET") return next();
  res.sendFile(path.join(__dirname, "/public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
