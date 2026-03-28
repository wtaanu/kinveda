/**
 * KinMentor Routes — /api/kinmentor
 */
const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { getDb } = require('../config/database');
const { requireAuth, requireKinMentor, requireAnyAuth } = require('../middleware/auth');
const { encrypt, decrypt, encryptJSON, decryptJSON } = require('../middleware/encrypt');

// ─── GET: My Dashboard Stats ─────────────────────────────────────────────────
router.get('/dashboard', requireAuth, requireKinMentor, (req, res) => {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const monthStart = now - (30 * 24 * 60 * 60);

  const stats = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM booking_sessions WHERE mentor_id = ? AND status != 'cancelled') AS total_sessions,
      (SELECT COUNT(*) FROM booking_sessions WHERE mentor_id = ? AND status = 'completed' AND scheduled_at > ?) AS sessions_this_month,
      (SELECT COALESCE(SUM(amount), 0) FROM booking_sessions WHERE mentor_id = ? AND status = 'completed' AND scheduled_at > ?) AS revenue_this_month,
      (SELECT COUNT(DISTINCT member_id) FROM booking_sessions WHERE mentor_id = ? AND status != 'cancelled') AS total_members,
      (SELECT COUNT(*) FROM booking_sessions WHERE mentor_id = ? AND scheduled_at > ? AND status IN ('confirmed','pending')) AS upcoming_sessions
  `).get(req.user.id, req.user.id, monthStart, req.user.id, monthStart, req.user.id, req.user.id, now);

  const profile = db.prepare('SELECT avg_rating, total_reviews FROM kinmentor_profiles WHERE user_id = ?').get(req.user.id);

  return res.json({
    success: true,
    stats: {
      totalSessions: stats.total_sessions,
      sessionsThisMonth: stats.sessions_this_month,
      revenueThisMonth: stats.revenue_this_month,
      totalMembers: stats.total_members,
      upcomingSessions: stats.upcoming_sessions,
      avgRating: profile?.avg_rating || 0,
      totalReviews: profile?.total_reviews || 0
    }
  });
});

// ─── GET / PUT: My Profile ────────────────────────────────────────────────────
router.get('/profile', requireAuth, requireKinMentor, (req, res) => {
  const db = getDb();
  const row = db.prepare(`
    SELECT u.email, u.name_enc, u.phone_enc, u.city_enc, kp.*
    FROM users u JOIN kinmentor_profiles kp ON kp.user_id = u.id
    WHERE u.id = ?
  `).get(req.user.id);

  if (!row) return res.status(404).json({ success: false, message: 'Profile not found.' });

  return res.json({
    success: true,
    profile: {
      name: decrypt(row.name_enc),
      email: row.email,
      phone: decrypt(row.phone_enc),
      city: decrypt(row.city_enc),
      rciLicense: row.rci_license,
      qualification: decrypt(row.qualification_enc),
      bio: decrypt(row.bio_enc),
      approach: decrypt(row.approach_enc),
      specializations: row.specializations ? JSON.parse(row.specializations) : [],
      languages: row.languages,
      experienceYears: row.experience_years,
      rate30min: row.rate_30min,
      rate60min: row.rate_60min,
      rateMonthly: row.rate_monthly,
      availability: row.availability_json ? JSON.parse(row.availability_json) : [],
      isRciVerified: !!row.is_rci_verified,
      isPaymentVerified: !!row.is_payment_verified,
      isProfilePublic: !!row.is_profile_public,
      avgRating: row.avg_rating,
      totalReviews: row.total_reviews,
      totalSessions: row.total_sessions
    }
  });
});

router.put('/profile', requireAuth, requireKinMentor, (req, res) => {
  const {
    name, phone, city, rciLicense, qualification, bio, approach,
    specializations, languages, experienceYears,
    rate30min, rate60min, rateMonthly, availability
  } = req.body;

  const db = getDb();
  db.prepare('UPDATE users SET name_enc = ?, phone_enc = ?, city_enc = ? WHERE id = ?')
    .run(encrypt(name), encrypt(phone), encrypt(city), req.user.id);

  db.prepare(`
    UPDATE kinmentor_profiles SET
      rci_license = ?, qualification_enc = ?, bio_enc = ?, approach_enc = ?,
      specializations = ?, languages = ?, experience_years = ?,
      rate_30min = ?, rate_60min = ?, rate_monthly = ?,
      availability_json = ?, updated_at = unixepoch()
    WHERE user_id = ?
  `).run(
    rciLicense, encrypt(qualification), encrypt(bio), encrypt(approach),
    JSON.stringify(specializations || []), languages, experienceYears || 0,
    rate30min || 0, rate60min || 0, rateMonthly || 0,
    JSON.stringify(availability || []),
    req.user.id
  );

  return res.json({ success: true, message: 'Profile updated.' });
});

// ─── GET: My Patients (Members) ──────────────────────────────────────────────
router.get('/members', requireAuth, requireKinMentor, (req, res) => {
  const db = getDb();
  const members = db.prepare(`
    SELECT DISTINCT u.id, u.name_enc, u.city_enc,
           kp.family_structure, kp.child_status, kp.assessment_completed, kp.package_active,
           (SELECT MAX(bs.scheduled_at) FROM booking_sessions bs WHERE bs.member_id = u.id AND bs.mentor_id = ? AND bs.status = 'completed') AS last_session,
           (SELECT MIN(bs.scheduled_at) FROM booking_sessions bs WHERE bs.member_id = u.id AND bs.mentor_id = ? AND bs.scheduled_at > unixepoch() AND bs.status IN ('confirmed','pending')) AS next_session
    FROM users u
    JOIN kinmember_profiles kp ON kp.user_id = u.id
    JOIN booking_sessions bs2 ON bs2.member_id = u.id AND bs2.mentor_id = ?
    WHERE u.role = 'kinmember'
  `).all(req.user.id, req.user.id, req.user.id);

  return res.json({
    success: true,
    members: members.map(m => ({
      id: m.id,
      name: decrypt(m.name_enc),
      city: decrypt(m.city_enc),
      familyStructure: m.family_structure,
      childStatus: m.child_status,
      assessmentCompleted: !!m.assessment_completed,
      packageActive: !!m.package_active,
      lastSession: m.last_session,
      nextSession: m.next_session
    }))
  });
});

// ─── GET: Session Queue ───────────────────────────────────────────────────────
router.get('/sessions', requireAuth, requireKinMentor, (req, res) => {
  const db = getDb();
  const sessions = db.prepare(`
    SELECT bs.*, u.name_enc AS member_name_enc,
           kp.family_structure, kp.child_status
    FROM booking_sessions bs
    JOIN users u ON u.id = bs.member_id
    JOIN kinmember_profiles kp ON kp.user_id = bs.member_id
    WHERE bs.mentor_id = ?
    ORDER BY bs.scheduled_at DESC
    LIMIT 50
  `).all(req.user.id);

  return res.json({
    success: true,
    sessions: sessions.map(s => ({
      id: s.id,
      memberName: decrypt(s.member_name_enc),
      familyStructure: s.family_structure,
      childStatus: s.child_status,
      scheduledAt: s.scheduled_at,
      durationMins: s.duration_mins,
      status: s.status,
      paymentStatus: s.payment_status,
      amount: s.amount
    }))
  });
});

// ─── GET / POST: Case Notes for a member ────────────────────────────────────
router.get('/notes/:memberId', requireAuth, requireKinMentor, (req, res) => {
  const db = getDb();
  const session = db.prepare(`
    SELECT bs.notes_enc FROM booking_sessions bs
    WHERE bs.mentor_id = ? AND bs.member_id = ? AND bs.notes_enc IS NOT NULL
    ORDER BY bs.scheduled_at DESC LIMIT 1
  `).get(req.user.id, req.params.memberId);

  return res.json({
    success: true,
    notes: session ? decrypt(session.notes_enc) : ''
  });
});

router.put('/notes/:sessionId', requireAuth, requireKinMentor,
  [body('notes').isString()],
  (req, res) => {
    const db = getDb();
    const session = db.prepare('SELECT id FROM booking_sessions WHERE id = ? AND mentor_id = ?').get(req.params.sessionId, req.user.id);
    if (!session) return res.status(404).json({ success: false, message: 'Session not found.' });
    db.prepare('UPDATE booking_sessions SET notes_enc = ?, updated_at = unixepoch() WHERE id = ?')
      .run(encrypt(req.body.notes), req.params.sessionId);
    return res.json({ success: true, message: 'Notes saved.' });
  }
);

// ─── POST: Add Homework for a Member ─────────────────────────────────────────
router.post('/homework', requireAuth, requireKinMentor,
  [body('memberId').isInt(), body('task').trim().isLength({ min: 3 })],
  (req, res) => {
    const { memberId, task, dueDate, sessionId } = req.body;
    const db = getDb();
    db.prepare('INSERT INTO homework (member_id, mentor_id, session_id, task_enc, due_date) VALUES (?, ?, ?, ?, ?)')
      .run(memberId, req.user.id, sessionId || null, encrypt(task), dueDate || null);
    return res.status(201).json({ success: true, message: 'Homework assigned.' });
  }
);

// ─── GET / POST: Blog Posts ───────────────────────────────────────────────────
router.get('/blog', requireAuth, requireKinMentor, (req, res) => {
  const db = getDb();
  const posts = db.prepare('SELECT id, title, slug, category, is_published, published_at, created_at FROM blog_posts WHERE mentor_id = ? ORDER BY created_at DESC').all(req.user.id);
  return res.json({ success: true, posts });
});

router.post('/blog', requireAuth, requireKinMentor,
  [body('title').trim().isLength({ min: 5 }), body('content').trim().isLength({ min: 50 })],
  (req, res) => {
    const { title, content, category, isPublished } = req.body;
    const db = getDb();
    const slug = title.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') + '-' + Date.now();
    const publishedAt = isPublished ? Math.floor(Date.now() / 1000) : null;
    const result = db.prepare('INSERT INTO blog_posts (mentor_id, title, slug, category, content, is_published, published_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(req.user.id, title, slug, category, content, isPublished ? 1 : 0, publishedAt);
    return res.status(201).json({ success: true, postId: result.lastInsertRowid, slug });
  }
);

// ─── GET: Feedback/Reviews for My Profile ────────────────────────────────────
router.get('/reviews', requireAuth, requireKinMentor, (req, res) => {
  const db = getDb();
  const reviews = db.prepare(`
    SELECT f.rating, f.comment_enc, f.is_public, f.created_at, kp.family_structure
    FROM feedback f JOIN kinmember_profiles kp ON kp.user_id = f.member_id
    WHERE f.mentor_id = ? ORDER BY f.created_at DESC LIMIT 20
  `).all(req.user.id);

  return res.json({
    success: true,
    reviews: reviews.map(r => ({
      rating: r.rating,
      comment: decrypt(r.comment_enc),
      isPublic: !!r.is_public,
      familyStructure: r.family_structure,
      createdAt: r.created_at
    }))
  });
});

// ─── PUBLIC: KinMentor Profile Page (for browse/booking) ─────────────────────
router.get('/public/:userId', (req, res) => {
  const db = getDb();
  const row = db.prepare(`
    SELECT u.id, u.name_enc, u.city_enc,
           kp.bio_enc, kp.approach_enc, kp.specializations, kp.languages,
           kp.experience_years, kp.rate_30min, kp.rate_60min, kp.rate_monthly,
           kp.availability_json, kp.is_rci_verified, kp.is_payment_verified,
           kp.avg_rating, kp.total_reviews, kp.total_sessions, kp.rci_license
    FROM users u JOIN kinmentor_profiles kp ON kp.user_id = u.id
    WHERE u.id = ? AND kp.is_profile_public = 1 AND u.is_active = 1
  `).get(req.params.userId);

  if (!row) return res.status(404).json({ success: false, message: 'Profile not found.' });

  const publicReviews = db.prepare(`
    SELECT f.rating, f.comment_enc, f.created_at, kp.family_structure
    FROM feedback f JOIN kinmember_profiles kp ON kp.user_id = f.member_id
    WHERE f.mentor_id = ? AND f.is_public = 1 ORDER BY f.created_at DESC LIMIT 5
  `).all(req.params.userId);

  const posts = db.prepare('SELECT id, title, slug, category, published_at FROM blog_posts WHERE mentor_id = ? AND is_published = 1 ORDER BY published_at DESC LIMIT 3').all(req.params.userId);

  return res.json({
    success: true,
    mentor: {
      id: row.id,
      name: decrypt(row.name_enc),
      city: decrypt(row.city_enc),
      bio: decrypt(row.bio_enc),
      approach: decrypt(row.approach_enc),
      specializations: row.specializations ? JSON.parse(row.specializations) : [],
      languages: row.languages,
      experienceYears: row.experience_years,
      rate30min: row.rate_30min,
      rate60min: row.rate_60min,
      rateMonthly: row.rate_monthly,
      availability: row.availability_json ? JSON.parse(row.availability_json) : [],
      isRciVerified: !!row.is_rci_verified,
      isPaymentVerified: !!row.is_payment_verified,
      avgRating: row.avg_rating,
      totalReviews: row.total_reviews,
      totalSessions: row.total_sessions,
      rciLicense: row.rci_license,
      reviews: publicReviews.map(r => ({
        rating: r.rating,
        comment: decrypt(r.comment_enc),
        familyStructure: r.family_structure,
        createdAt: r.created_at
      })),
      posts
    }
  });
});

// ─── AVAILABILITY SLOTS ───────────────────────────────────────────────────────
// GET /api/kinmentor/availability — my current slots
router.get('/availability', requireAuth, requireKinMentor, (req, res) => {
  const db = getDb();
  const slots = db.prepare(`
    SELECT * FROM mentor_availability
    WHERE mentor_id = ? AND is_active = 1
    ORDER BY day_of_week, start_time
  `).all(req.user.id);
  res.json({ success: true, slots });
});

// POST /api/kinmentor/availability — add a slot
router.post('/availability', requireAuth, requireKinMentor, [
  body('dayOfWeek').isInt({ min: 0, max: 6 }),
  body('startTime').matches(/^\d{2}:\d{2}$/),
  body('endTime').matches(/^\d{2}:\d{2}$/)
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

  const { dayOfWeek, startTime, endTime, label, effectiveFrom, effectiveUntil } = req.body;
  const db = getDb();

  const result = db.prepare(`
    INSERT INTO mentor_availability (mentor_id, day_of_week, start_time, end_time, label, effective_from, effective_until, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
  `).run(req.user.id, dayOfWeek, startTime, endTime, label || null, effectiveFrom || null, effectiveUntil || null);

  res.json({ success: true, slotId: result.lastInsertRowid });
});

// POST /api/kinmentor/availability/bulk — save full week schedule (replace existing)
router.post('/availability/bulk', requireAuth, requireKinMentor, (req, res) => {
  const { slots } = req.body; // array of { dayOfWeek, startTime, endTime, label }
  if (!Array.isArray(slots)) return res.status(400).json({ success: false, message: 'slots array required' });

  const db = getDb();
  const mentorId = req.user.id;

  // Deactivate existing slots (soft delete)
  db.prepare('UPDATE mentor_availability SET is_active = 0 WHERE mentor_id = ?').run(mentorId);

  const insert = db.prepare(`
    INSERT INTO mentor_availability (mentor_id, day_of_week, start_time, end_time, label, effective_from, effective_until, is_active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, unixepoch())
  `);
  const insertAll = db.transaction((slots) => {
    for (const s of slots) {
      if (!s.startTime || !s.endTime || s.dayOfWeek === undefined) continue;
      insert.run(mentorId, s.dayOfWeek, s.startTime, s.endTime, s.label || null,
        s.effectiveFrom || null, s.effectiveUntil || null);
    }
  });

  insertAll(slots);
  res.json({ success: true, count: slots.length });
});

// DELETE /api/kinmentor/availability/:id
router.delete('/availability/:id', requireAuth, requireKinMentor, (req, res) => {
  const db = getDb();
  db.prepare('UPDATE mentor_availability SET is_active = 0 WHERE id = ? AND mentor_id = ?').run(req.params.id, req.user.id);
  res.json({ success: true });
});

// ─── REVENUE DASHBOARD ────────────────────────────────────────────────────────
router.get('/revenue', requireAuth, requireKinMentor, (req, res) => {
  const db = getDb();

  // Monthly earnings
  const monthly = db.prepare(`
    SELECT strftime('%Y-%m', datetime(scheduled_at, 'unixepoch')) AS month,
           COUNT(*) AS sessions,
           COALESCE(SUM(amount), 0) AS gross
    FROM booking_sessions
    WHERE mentor_id = ? AND status = 'completed'
    GROUP BY month ORDER BY month DESC LIMIT 12
  `).all(req.user.id);

  // Per-member breakdown (last 20)
  const byMember = db.prepare(`
    SELECT u.name_enc, u.email,
           COUNT(bs.id) AS sessions,
           COALESCE(SUM(bs.amount), 0) AS total_paid
    FROM booking_sessions bs
    JOIN users u ON u.id = bs.member_id
    WHERE bs.mentor_id = ? AND bs.status = 'completed'
    GROUP BY bs.member_id
    ORDER BY total_paid DESC
    LIMIT 20
  `).all(req.user.id);

  // Received payouts
  const payouts = db.prepare(`
    SELECT p.payout_amount, p.gross_amount, p.platform_cut_pct, p.processed_at, p.transfer_ref, p.notes,
           bs.scheduled_at, u.name_enc AS member_name_enc, u.email AS member_email
    FROM payouts p
    LEFT JOIN booking_sessions bs ON bs.id = p.session_id
    LEFT JOIN users u ON u.id = bs.member_id
    WHERE p.mentor_id = ? AND p.status = 'processed'
    ORDER BY p.processed_at DESC LIMIT 50
  `).all(req.user.id);

  const profile = db.prepare('SELECT total_earned, total_paid_out FROM kinmentor_profiles WHERE user_id = ?').get(req.user.id);

  res.json({
    success: true,
    summary: {
      totalEarned:  profile?.total_earned || 0,
      totalPaidOut: profile?.total_paid_out || 0,
      balance:      (profile?.total_earned || 0) - (profile?.total_paid_out || 0)
    },
    monthly,
    byMember: byMember.map(m => ({ ...m, memberName: decrypt(m.name_enc), name_enc: undefined })),
    payouts: payouts.map(p => ({ ...p, memberName: decrypt(p.member_name_enc), member_name_enc: undefined }))
  });
});

// ─── VIDEO SESSION: Upload recording link ─────────────────────────────────────
router.patch('/sessions/:sessionId/recording', requireAuth, requireKinMentor, (req, res) => {
  const { recordingUrl } = req.body;
  if (!recordingUrl) return res.status(400).json({ success: false, message: 'Recording URL required' });

  const db = getDb();
  // Verify session belongs to this mentor
  const session = db.prepare('SELECT id FROM booking_sessions WHERE id = ? AND mentor_id = ?')
    .get(req.params.sessionId, req.user.id);
  if (!session) return res.status(404).json({ success: false, message: 'Session not found' });

  db.prepare(`
    UPDATE video_sessions SET recording_url = ?, recording_uploaded_by = ? WHERE session_id = ?
  `).run(recordingUrl, req.user.id, req.params.sessionId);

  res.json({ success: true, message: 'Recording link saved. KinMember can now view the recording.' });
});

// ─── GET /api/kinmentor/messages/:memberId ─────────────────────────────────────
// KinMentor reads messages with a specific member
router.get('/messages/:memberId', requireAuth, requireKinMentor, (req, res) => {
  const db = getDb();
  const { decrypt } = require('../middleware/encrypt');
  const memberId = parseInt(req.params.memberId);

  // Verify this member is assigned to this mentor
  const member = db.prepare('SELECT id FROM kinmember_profiles WHERE user_id = ? AND assigned_mentor_id = ?')
    .get(memberId, req.user.id);
  if (!member) return res.status(403).json({ success: false, message: 'Member not assigned to you' });

  const msgs = db.prepare(`
    SELECT cm.*, u.name AS sender_name
    FROM chat_messages cm
    JOIN users u ON u.id = cm.sender_id
    WHERE (cm.sender_id = ? AND cm.receiver_id = ?)
       OR (cm.sender_id = ? AND cm.receiver_id = ?)
    ORDER BY cm.created_at ASC
    LIMIT 200
  `).all(memberId, req.user.id, req.user.id, memberId);

  // Mark messages from member as read
  db.prepare('UPDATE chat_messages SET is_read = 1 WHERE sender_id = ? AND receiver_id = ?')
    .run(memberId, req.user.id);

  res.json({
    success: true,
    messages: msgs.map(m => ({
      id: m.id,
      message: decrypt(m.message_enc),
      isMine: m.sender_id === req.user.id,
      createdAt: m.created_at
    }))
  });
});

// ─── POST /api/kinmentor/messages/:memberId ────────────────────────────────────
// KinMentor sends a message to a specific member
router.post('/messages/:memberId', requireAuth, requireKinMentor, (req, res) => {
  const db = getDb();
  const { encrypt } = require('../middleware/encrypt');
  const memberId = parseInt(req.params.memberId);
  const { message } = req.body;
  if (!message?.trim()) return res.status(400).json({ success: false, message: 'Message required' });

  // Verify this member is assigned to this mentor
  const member = db.prepare('SELECT id FROM kinmember_profiles WHERE user_id = ? AND assigned_mentor_id = ?')
    .get(memberId, req.user.id);
  if (!member) return res.status(403).json({ success: false, message: 'Member not assigned to you' });

  db.prepare('INSERT INTO chat_messages (sender_id, receiver_id, message_enc) VALUES (?, ?, ?)')
    .run(req.user.id, memberId, encrypt(message.trim()));

  res.json({ success: true });
});

module.exports = router;
