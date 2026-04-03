/**
 * KinVeda Authentication Middleware
 * JWT-based role authentication.
 * Tokens are short-lived (access) + long-lived (refresh, httpOnly cookie).
 */
require('dotenv').config();
const jwt = require('jsonwebtoken');
const { getDb } = require('../config/database');
const { hashToken } = require('./encrypt');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES = process.env.JWT_EXPIRES_IN || '15m';
const JWT_REFRESH_EXPIRES = process.env.JWT_REFRESH_EXPIRES_IN || '30d';

// ─── Token Generators ─────────────────────────────────────────────────────────

function generateAccessToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );
}

function generateRefreshToken(user) {
  const { v4: uuidv4 } = require('uuid');
  const rawToken = uuidv4() + '-' + uuidv4();
  // Store hash in DB, return raw to client (httpOnly cookie)
  const db = getDb();
  const expiresAt = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60; // 30 days
  db.prepare(`
    INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
    VALUES (?, ?, ?)
  `).run(user.id, hashToken(rawToken), expiresAt);
  return rawToken;
}

// ─── Middleware: requireAuth ───────────────────────────────────────────────────

function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : req.cookies && req.cookies.access_token;

  if (!token) {
    return res.status(401).json({ success: false, message: 'Authentication required.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, message: 'Session expired. Please sign in again.', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ success: false, message: 'Invalid token.' });
  }
}

// ─── Role Guards ──────────────────────────────────────────────────────────────

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ success: false, message: 'Not authenticated.' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Access denied. Insufficient role.' });
    }
    next();
  };
}

const requireKinMember  = requireRole('kinmember');
const requireKinMentor  = requireRole('kinmentor');
const requireAdmin      = requireRole('admin');
const requireAnyAuth    = requireRole('kinmember', 'kinmentor', 'admin');

// ─── Optional Auth (attach user if token present, don't block) ───────────────

function optionalAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : req.cookies && req.cookies.access_token;

  if (token) {
    try {
      req.user = jwt.verify(token, JWT_SECRET);
    } catch { /* ignore */ }
  }
  next();
}

module.exports = {
  generateAccessToken,
  generateRefreshToken,
  requireAuth,
  requireRole,
  requireKinMember,
  requireKinMentor,
  requireAdmin,
  requireAnyAuth,
  optionalAuth
};
