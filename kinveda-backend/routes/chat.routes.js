/**
 * Chat-With-Us Routes — /api/chat
 * Public enquiry widget that immediately sends email to all admin IDs.
 */
const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const { getDb } = require('../config/database');
const { encrypt } = require('../middleware/encrypt');
const { optionalAuth } = require('../middleware/auth');
const { sendAdminChatNotification } = require('../config/mailer');

// Prevent spam: 5 messages per 15 min per IP
const chatLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { success: false, message: 'Too many messages. Please try again in 15 minutes.' }
});

router.post('/',
  chatLimiter,
  optionalAuth,
  [
    body('name').optional().trim().isLength({ max: 100 }),
    body('email').optional().isEmail().normalizeEmail(),
    body('message').trim().isLength({ min: 5, max: 2000 }).withMessage('Message required (5–2000 characters).')
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

    const { name, email, message, sourcePage } = req.body;
    const db = getDb();

    // Auto-create pre-registered user if email provided and not already in system
    let userId = req.user?.id || null;
    if (email && !userId) {
      const existingUser = db.prepare('SELECT id, signup_status FROM users WHERE email = ?').get(email.toLowerCase());
      if (!existingUser) {
        // Create a ghost/pre-registered account so admin can follow up
        const result = db.prepare(`
          INSERT INTO users (email, password_hash, role, name_enc, signup_status, created_at, updated_at)
          VALUES (?, '', 'kinmember', ?, 'pre_registered', unixepoch(), unixepoch())
        `).run(email.toLowerCase(), name ? encrypt(name) : null);
        userId = result.lastInsertRowid;
        db.prepare('INSERT OR IGNORE INTO kinmember_profiles (user_id) VALUES (?)').run(userId);
      } else {
        userId = existingUser.id;
      }
    }

    // Store encrypted in DB
    db.prepare(`
      INSERT INTO contact_enquiries (name_enc, email_enc, message_enc, source_page, user_id, email_sent)
      VALUES (?, ?, ?, ?, ?, 0)
    `).run(
      name  ? encrypt(name)  : null,
      email ? encrypt(email) : null,
      encrypt(message),
      sourcePage || 'unknown',
      userId
    );

    // Fire email to all admin IDs
    const enquiry = {
      name: name || (req.user ? `User #${req.user.id}` : 'Anonymous'),
      email: email || req.user?.email || 'Not provided',
      message,
      sourcePage
    };

    try {
      await sendAdminChatNotification(enquiry);
      // Mark email sent
      db.prepare('UPDATE contact_enquiries SET email_sent = 1 WHERE rowid = last_insert_rowid()').run();
    } catch (err) {
      console.error('[Chat] Email failed:', err.message);
    }

    return res.json({
      success: true,
      message: 'Thank you! Our team has been notified and will reach out within 2 hours.'
    });
  }
);

module.exports = router;
