// auth/cognito.js
const {
  CognitoIdentityProviderClient,
  SignUpCommand,
  ConfirmSignUpCommand,
  InitiateAuthCommand,
  ResendConfirmationCodeCommand,
} = require("@aws-sdk/client-cognito-identity-provider");
const crypto = require("crypto");

const region = process.env.AWS_REGION;
const userPoolId = process.env.COGNITO_USER_POOL_ID;
const clientId = process.env.COGNITO_APP_CLIENT_ID;
const clientSecret = process.env.COGNITO_APP_CLIENT_SECRET;

if (!region || !userPoolId || !clientId) {
  throw new Error(
    "Missing AWS_REGION / COGNITO_USER_POOL_ID / COGNITO_APP_CLIENT_ID"
  );
}
if (!clientSecret) {
  throw new Error(
    "Missing COGNITO_APP_CLIENT_SECRET (required when your app client has a secret)"
  );
}

const issuer = `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;
const cip = new CognitoIdentityProviderClient({ region });

// ESM-only 'jose' → lazy dynamic import (works in CommonJS)
let verifierCache = null;
async function getVerifier() {
  if (verifierCache) return verifierCache;
  const { createRemoteJWKSet, jwtVerify } = await import("jose");
  const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
  verifierCache = { jwtVerify, jwks };
  return verifierCache;
}

// Compute Cognito SECRET_HASH = Base64(HMAC_SHA256(secret, username + clientId))
function secretHash(username) {
  return crypto
    .createHmac("sha256", clientSecret)
    .update(username + clientId)
    .digest("base64");
}

// ---------- API wrappers ----------
async function signUp({ username, password, email }) {
  await cip.send(
    new SignUpCommand({
      ClientId: clientId,
      Username: username,
      Password: password,
      UserAttributes: [{ Name: "email", Value: email }],
      SecretHash: secretHash(username),
    })
  );
  return { ok: true };
}

async function confirmSignUp({ username, code }) {
  await cip.send(
    new ConfirmSignUpCommand({
      ClientId: clientId,
      Username: username,
      ConfirmationCode: code,
      SecretHash: secretHash(username),
    })
  );
  return { ok: true };
}

async function resendCode({ username }) {
  await cip.send(
    new ResendConfirmationCodeCommand({
      ClientId: clientId,
      Username: username,
      SecretHash: secretHash(username),
    })
  );
  return { ok: true };
}

async function login({ username, password }) {
  const out = await cip.send(
    new InitiateAuthCommand({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: clientId,
      AuthParameters: {
        USERNAME: username,
        PASSWORD: password,
        SECRET_HASH: secretHash(username), // NOTE: UPPERCASE key here
      },
    })
  );
  const tok = out.AuthenticationResult || {};
  return {
    idToken: tok.IdToken,
    accessToken: tok.AccessToken,
    refreshToken: tok.RefreshToken,
    expiresIn: tok.ExpiresIn,
    tokenType: tok.TokenType,
  };
}

// ---------- Express middleware ----------
async function authenticateCognito(req, res, next) {
  try {
    const hdr = req.headers.authorization || "";
    const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : null;
    if (!token) return res.sendStatus(401);

    const { jwtVerify, jwks } = await getVerifier();
    const { payload } = await jwtVerify(token, jwks, {
      issuer,
      audience: clientId,
    });

    req.user = payload; // sub, email, "cognito:groups", etc.
    next();
  } catch {
    return res.sendStatus(401);
  }
}

module.exports = {
  signUp,
  confirmSignUp,
  resendCode,
  login,
  authenticateCognito,
};
