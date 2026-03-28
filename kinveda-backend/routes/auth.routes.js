/**
 * Auth Routes — /api/auth
 * POST /signup        Register as KinMember or KinMentor
 * POST /signin        Sign in — returns access token + sets refresh cookie
 * POST /refresh       Exchange refresh token for new access token
 * POST /signout       Revoke refresh token
 * POST /forgot        Request password reset email
 * POST /reset         Submit new password with reset token
 * GET  /me            Return current user profile (requires auth)
 */
const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const bcrypt = require('bcryptjs');
const { getDb } = require('../config/database');
const { encrypt, decrypt, hashToken, generateToken } = require('../middleware/encrypt');
const { generateAccessToken, generateRefreshToken, requireAuth } = require('../middleware/auth');
const { sendWelcomeEmail, sendPasswordReset } = require('../config/mailer');

// Strict rate limit for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.AUTH_RATE_LIMIT_MAX || '10'),
  message: { success: false, message: 'Too many attempts. Please try again in 15 minutes.' }
});

// ─── SIGNUP ───────────────────────────────────────────────────────────────────
router.post('/signup',
  authLimiter,
  [
    body('email').isEmail().normalizeEmail().withMessage('Valid email required.'),
    body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters.'),
    body('name').trim().isLength({ min: 2 }).withMessage('Name required.'),
    body('role').isIn(['kinmember', 'kinmentor']).withMessage('Role must be kinmember or kinmentor.')
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

    const { email, password, name, role, phone, city } = req.body;
    const db = getDb();

    // Check duplicate — allow pre-registered users to complete signup
    const existing = db.prepare('SELECT id, signup_status FROM users WHERE email = ?').get(email.toLowerCase());
    if (existing && existing.signup_status !== 'pre_registered') {
      return res.status(409).json({ success: false, message: 'An account with this email already exists.' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    let userId;

    if (existing && existing.signup_status === 'pre_registered') {
      // Complete the pre-registration: upgrade to full account
      db.prepare(`
        UPDATE users SET
          password_hash = ?, role = ?, name_enc = ?, phone_enc = ?, city_enc = ?,
          signup_status = 'registered', updated_at = unixepoch()
        WHERE id = ?
      `).run(
        passwordHash, role,
        encrypt(name),
        phone ? encrypt(phone) : null,
        city  ? encrypt(city)  : null,
        existing.id
      );
      userId = existing.id;
      // Link any existing contact enquiries to this user
      db.prepare('UPDATE contact_enquiries SET user_id = ? WHERE user_id IS NULL AND email_enc IS NOT NULL').run(userId);
    } else {
      const result = db.prepare(`
        INSERT INTO users (email, password_hash, role, name_enc, phone_enc, city_enc, signup_status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'registered', unixepoch(), unixepoch())
      `).run(
        email.toLowerCase(), passwordHash, role,
        encrypt(name),
        phone ? encrypt(phone) : null,
        city  ? encrypt(city)  : null
      );
      userId = result.lastInsertRowid;
    }

    // Create role-specific profile skeleton (if not already exists)
    if (role === 'kinmember') {
      db.prepare('INSERT OR IGNORE INTO kinmember_profiles (user_id) VALUES (?)').run(userId);
    } else {
      db.prepare('INSERT OR IGNORE INTO kinmentor_profiles (user_id) VALUES (?)').run(userId);
    }

    // Send welcome email (non-blocking)
    sendWelcomeEmail(email, name, role).catch(console.error);

    // Issue tokens
    const user = { id: userId, email: email.toLowerCase(), role };
    const accessToken  = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user);

    res.cookie('refresh_token', refreshToken, {
      httpOnly: true, secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict', maxAge: 30 * 24 * 60 * 60 * 1000
    });

    return res.status(201).json({
      success: true,
      message: 'Account created successfully.',
      accessToken,
      user: { id: userId, email: email.toLowerCase(), role, name }
    });
  }
);

// ─── SIGNIN ───────────────────────────────────────────────────────────────────
router.post('/signin',
  authLimiter,
  [
    body('email').isEmail().normalizeEmail(),
    body('password').notEmpty()
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

    const { email, password } = req.body;
    const db = getDb();

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
    if (!user) return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    if (!user.is_active) return res.status(403).json({ success: false, message: 'Account suspended. Contact support.' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ success: false, message: 'Invalid email or password.' });

    // Update last_login
    db.prepare('UPDATE users SET last_login = unixepoch() WHERE id = ?').run(user.id);

    const userPayload = { id: user.id, email: user.email, role: user.role };
    const accessToken  = generateAccessToken(userPayload);
    const refreshToken = generateRefreshToken(userPayload);

    res.cookie('refresh_token', refreshToken, {
      httpOnly: true, secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict', maxAge: 30 * 24 * 60 * 60 * 1000
    });

    return res.json({
      success: true,
      accessToken,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        name: decrypt(user.name_enc)
      },
      redirectTo: user.role === 'admin'
        ? `${process.env.ADMIN_ROUTE_PREFIX}`
        : user.role === 'kinmentor'
          ? '/kinveda-kinmentor.html'
          : '/kinveda-kinmember.html'
    });
  }
);

// ─── REFRESH ──────────────────────────────────────────────────────────────────
router.post('/refresh', (req, res) => {
  const rawToken = req.cookies?.refresh_token;
  if (!rawToken) return res.status(401).json({ success: false, message: 'No refresh token.' });

  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const record = db.prepare(`
    SELECT rt.*, u.role, u.email, u.is_active
    FROM refresh_tokens rt
    JOIN users u ON rt.user_id = u.id
    WHERE rt.token_hash = ? AND rt.revoked = 0 AND rt.expires_at > ?
  `).get(hashToken(rawToken), now);

  if (!record) return res.status(401).json({ success: false, message: 'Invalid or expired refresh token.' });
  if (!record.is_active) return res.status(403).json({ success: false, message: 'Account suspended.' });

  const user = { id: record.user_id, email: record.email, role: record.role };
  const newAccessToken = generateAccessToken(user);

  return res.json({ success: true, accessToken: newAccessToken });
});

// ─── SIGNOUT ──────────────────────────────────────────────────────────────────
router.post('/signout', (req, res) => {
  const rawToken = req.cookies?.refresh_token;
  if (rawToken) {
    const db = getDb();
    db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE token_hash = ?').run(hashToken(rawToken));
  }
  res.clearCookie('refresh_token');
  return res.json({ success: true, message: 'Signed out successfully.' });
});

// ─── FORGOT PASSWORD ──────────────────────────────────────────────────────────
router.post('/forgot', authLimiter, [body('email').isEmail().normalizeEmail()], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

  // Always return success to prevent email enumeration
  const { email } = req.body;
  const db = getDb();
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());

  if (user) {
    const token = generateToken(32);
    const expiry = Math.floor(Date.now() / 1000) + 3600; // 1 hour
    db.prepare('UPDATE users SET reset_token = ?, reset_token_expiry = ? WHERE id = ?')
      .run(token, expiry, user.id);
    const resetUrl = `${process.env.FRONTEND_URL}/kinveda-reset.html?token=${token}`;
    sendPasswordReset(email, resetUrl).catch(console.error);
  }

  return res.json({ success: true, message: 'If that email exists, a reset link has been sent.' });
});

// ─── RESET PASSWORD ───────────────────────────────────────────────────────────
router.post('/reset', authLimiter,
  [body('token').notEmpty(), body('password').isLength({ min: 8 })],
  async (req, res) => {
    const { token, password } = req.body;
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    const user = db.prepare('SELECT id FROM users WHERE reset_token = ? AND reset_token_expiry > ?').get(token, now);

    if (!user) return res.status(400).json({ success: false, message: 'Invalid or expired reset link.' });

    const hash = await bcrypt.hash(password, 12);
    db.prepare('UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expiry = NULL WHERE id = ?')
      .run(hash, user.id);

    return res.json({ success: true, message: 'Password updated. Please sign in.' });
  }
);

// ─── ME (current user) ────────────────────────────────────────────────────────
router.get('/me', requireAuth, (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT id, email, role, name_enc, phone_enc, city_enc, is_verified, created_at FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

  return res.json({
    success: true,
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      name: decrypt(user.name_enc),
      phone: decrypt(user.phone_enc),
      city: decrypt(user.city_enc),
      isVerified: !!user.is_verified,
      createdAt: user.created_at
    }
  });
});

module.exports = router;
