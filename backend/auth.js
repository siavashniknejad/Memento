// Authentication helpers.
//
// How this works, in plain terms:
// 1. On register/login, we give the browser a signed JWT ("JSON Web Token").
//    Think of it as a tamper-proof ID card: it says "user #7" and is signed
//    with a secret only our server knows, so nobody can forge one.
// 2. The browser stores that token and sends it back on every request
//    (in the "Authorization: Bearer <token>" header).
// 3. requireAuth() below checks that header on protected routes, verifies
//    the signature, and — if valid — attaches the user's id to req.userId
//    so route handlers know who's asking.

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.error('Missing JWT_SECRET. Set it in your .env file.');
  process.exit(1);
}

function signToken(userId) {
  // Token stays valid for 30 days — long enough that users don't have to
  // log in constantly on a personal flashcard app.
  return jwt.sign({ userId: userId }, JWT_SECRET, { expiresIn: '30d' });
}

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header.' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.userId;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

module.exports = { signToken, requireAuth };
