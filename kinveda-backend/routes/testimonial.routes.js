/**
 * KinVeda Testimonial Routes
 * POST /api/testimonials          – Submit a story (authenticated KinMember)
 * GET  /api/testimonials/public   – Public approved testimonials (landing page)
 * GET  /api/testimonials/mine     – KinMember's own submissions
 */

const express = require('express');
const router  = express.Router();
const { getDb } = require('../config/database');
const { requireAuth, requireKinMember } = require('../middleware/auth');
const { encrypt, decrypt } = require('../middleware/encrypt');

// ─── POST /api/testimonials ───────────────────────────────────────────────────
router.post('/', requireAuth, requireKinMember, (req, res) => {
  try {
    const { rating, story, authorDisplay, concernTag } = req.body;
    if (!rating || !story) return res.status(400).json({ success: false, message: 'Rating and story are required' });
    if (rating < 1 || rating > 5) return res.status(400).json({ success: false, message: 'Rating must be 1–5' });

    const db = getDb();
    const storyEnc = encrypt(story.trim().slice(0, 2000));

    // Auto-approve if 4+ stars, pending admin review otherwise
    const isPublic    = rating >= 4 ? 0 : 0; // always needs admin approval first
    const isApproved  = 0;

    db.prepare(`
      INSERT INTO testimonials (user_id, rating, story_enc, author_display, concern_tag, is_approved, is_public, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
    `).run(req.user.id, rating, storyEnc, authorDisplay || null, concernTag || null, isApproved, isPublic);

    res.json({ success: true, message: rating >= 4
      ? '🙏 Thank you! Your story will appear on our landing page after a quick review.'
      : '🙏 Thank you for sharing. Your feedback helps us improve.' });
  } catch (err) {
    console.error('[Testimonials] submit error:', err);
    res.status(500).json({ success: false, message: 'Could not save testimonial' });
  }
});

// ─── GET /api/testimonials/public ─────────────────────────────────────────────
// No auth required — used on landing page
router.get('/public', (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT id, rating, author_display, concern_tag, created_at, story_enc
      FROM testimonials
      WHERE is_approved = 1 AND is_public = 1 AND rating >= 4
      ORDER BY created_at DESC
      LIMIT 20
    `).all();

    const testimonials = rows.map(r => ({
      id:            r.id,
      rating:        r.rating,
      authorDisplay: r.author_display,
      concernTag:    r.concern_tag,
      story:         decrypt(r.story_enc),
      createdAt:     r.created_at
    }));

    res.json({ success: true, testimonials });
  } catch (err) {
    console.error('[Testimonials] public error:', err);
    res.status(500).json({ success: false, message: 'Could not load testimonials' });
  }
});

// ─── GET /api/testimonials/mine ───────────────────────────────────────────────
// Authenticated KinMember views their own submissions
router.get('/mine', requireAuth, requireKinMember, (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT id, rating, author_display, concern_tag, is_approved, is_public, created_at, story_enc
      FROM testimonials
      WHERE user_id = ?
      ORDER BY created_at DESC
    `).all(req.user.id);

    const testimonials = rows.map(r => ({
      id:            r.id,
      rating:        r.rating,
      authorDisplay: r.author_display,
      concernTag:    r.concern_tag,
      story:         decrypt(r.story_enc),
      createdAt:     r.created_at,
      status: r.is_approved ? 'approved' : (r.is_public === -1 ? 'rejected' : 'pending')
    }));

    res.json({ success: true, testimonials });
  } catch (err) {
    console.error('[Testimonials] mine error:', err);
    res.status(500).json({ success: false, message: 'Could not load your stories' });
  }
});

module.exports = router;
