//INDEX FILE - Parts of code copied from tutorials, some generative AI used for troubleshooting and bug fixes

const express = require('express'); //Start the server
const fileUpload = require('express-fileupload');
const JWT = require('./jwt'); //Start JWT for authentication
const videoRoutes = require('./routes/videos');
const app = express();
const PORT = 3000;

//Admin and CAB432 user profiles - taken from CAB432 Tutorial code
const users = {
  CAB432: { password: 'supersecret', admin: false },
  admin:  { password: 'admin',       admin: true  },
};

//Middleware
app.use(express.json());
app.use(fileUpload());

//Generate the token for authentication
app.post('/auth/login', (req, res) => {
  const { username, password } = req.body;
  const user = users[username];
  if (!user || password !== user.password) return res.sendStatus(401);
  const token = JWT.generateAccessToken({ username });
  return res.json({ authToken: token });
});

//Admin getter
app.get('/admin', JWT.authenticateToken, (req, res) => {
  const user = users[req.user.username];
  if (!user || !user.admin) return res.sendStatus(403);
  return res.json({ message: 'Admin only content.' });
});

app.use('/videos', JWT.authenticateToken, videoRoutes);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
