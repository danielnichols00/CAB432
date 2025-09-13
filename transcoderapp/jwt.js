//JWT AUTH - Code mostly taken from tutorial (AI assistance for bug fixes and accuracy passing paramaters)

const jwt = require("jsonwebtoken");

//Fixed secret for now as rubric does not require it to be dynamic - will update for assignments 2/3
const tokenSecret =
   "e9aae26be08551392be664d620fb422350a30349899fc254a0f37bfa1b945e36ff20d25b12025e1067f9b69e8b8f2ef0f767f6fff6279e5755668bf4bae88588";

//Create token using username and set to expire in 30m
const generateAccessToken = (username) => {
   return jwt.sign(username, tokenSecret, { expiresIn: "30m" });
};

//Middleware verifying token depending on user
const authenticateToken = (req, res, next) => {
   // We are using Bearer auth.  The token is in the authorization header.
   const authHeader = req.headers["authorization"];
   const token = authHeader && authHeader.split(' ')[1];

   if (!token) {
      console.log("JSON web token missing.");
      return res.sendStatus(401);
   }

   //Validation check
   try {
      const user = jwt.verify(token, tokenSecret);

      console.log(
         `authToken verified for user: ${user.username} at URL ${req.url}`
      );

      // Add user info to the request for the next handler
      req.user = user;
      next();
   } catch (err) {
      console.log(
         `JWT verification failed at URL ${req.url}`,
         err.name,
         err.message
      );
      return res.sendStatus(401);
   }
};

module.exports = { generateAccessToken, authenticateToken };
