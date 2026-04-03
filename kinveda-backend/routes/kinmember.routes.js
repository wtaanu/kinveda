/**
 * KinMember Routes — /api/kinmember
 * All routes require role = 'kinmember'
 */
const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { getDb } = require('../config/database');
const { requireAuth, requireKinMember } = require('../middleware/auth');
const { encrypt, decrypt, encryptJSON, decryptJSON } = require('../middleware/encrypt');
const { sendSOSAlert, sendSessionRequestedEmail } = require('../config/mailer');

// ─── GET: My Profile ──────────────────────────────────────────────────────────
router.get('/profile', requireAuth, requireKinMember, (req, res) => {
  const db = getDb();
  const profile = db.prepare(`
    SELECT u.email, u.name_enc, u.phone_enc, u.city_enc, u.is_verified, u.created_at,
           kp.*
    FROM users u
    JOIN kinmember_profiles kp ON kp.user_id = u.id
    WHERE u.id = ?
  `).get(req.user.id);

  if (!profile) return res.status(404).json({ success: false, message: 'Profile not found.' });

  // Get assigned mentor name
  let mentorName = null;
  if (profile.assigned_mentor_id) {
    const mentor = db.prepare('SELECT name_enc FROM users WHERE id = ?').get(profile.assigned_mentor_id);
    if (mentor) mentorName = decrypt(mentor.name_enc);
  }

  return res.json({
    success: true,
    profile: {
      name: decrypt(profile.name_enc),
      email: profile.email,
      phone: decrypt(profile.phone_enc),
      city: decrypt(profile.city_enc),
      isVerified: !!profile.is_verified,
      familyStructure: profile.family_structure,
      childStatus: profile.child_status,
      primaryConcerns: decryptJSON(profile.primary_concerns_enc) || [],
      household: decrypt(profile.household_enc),
      wellnessScore: profile.wellness_score,
      assignedMentorId: profile.assigned_mentor_id,
      assignedMentorName: mentorName,
      assessmentCompleted: !!profile.assessment_completed,
      packageActive: !!profile.package_active,
      packageRenewalDate: profile.package_renewal_date,
      memberSince: profile.created_at
    }
  });
});

// ─── PUT: Update Profile ──────────────────────────────────────────────────────
router.put('/profile', requireAuth, requireKinMember,
  [
    body('name').trim().isLength({ min: 2, max: 120 }).withMessage('Name must be 2–120 chars.'),
    body('phone').optional({ nullable: true }).trim().isLength({ max: 20 }),
    body('city').optional({ nullable: true }).trim().isLength({ max: 80 }),
  ],
  (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

  const { name, phone, city } = req.body;
  const db = getDb();
  db.prepare('UPDATE users SET name_enc = ?, phone_enc = ?, city_enc = ? WHERE id = ?')
    .run(encrypt(name), encrypt(phone), encrypt(city), req.user.id);
  return res.json({ success: true, message: 'Profile updated.' });
});

// ─── POST: Submit Assessment ──────────────────────────────────────────────────
router.post('/assessment', requireAuth, requireKinMember, (req, res) => {
  const { responses, score, sosTriggered } = req.body;
  const db = getDb();

  const result = db.prepare(`
    INSERT INTO assessments (user_id, data_enc, score, sos_triggered)
    VALUES (?, ?, ?, ?)
  `).run(req.user.id, encryptJSON(responses), score || 0, sosTriggered ? 1 : 0);

  // Update profile
  db.prepare(`
    UPDATE kinmember_profiles SET assessment_completed = 1,
    family_structure = ?, child_status = ?, primary_concerns_enc = ?, household_enc = ?, updated_at = unixepoch()
    WHERE user_id = ?
  `).run(
    responses.familyStructure || null,
    responses.childStatus || null,
    encryptJSON(responses.primaryConcerns),
    responses.household ? encrypt(responses.household) : null,
    req.user.id
  );

  // SOS event
  if (sosTriggered) {
    db.prepare('INSERT INTO sos_events (user_id, trigger_type) VALUES (?, ?)').run(req.user.id, 'assessment');
    const user = db.prepare('SELECT name_enc FROM users WHERE id = ?').get(req.user.id);
    const userName = decrypt(user?.name_enc) || 'Anonymous';
    sendSOSAlert({ trigger_type: 'assessment' }, userName).catch(console.error);
  }

  return res.status(201).json({
    success: true,
    assessmentId: result.lastInsertRowid,
    message: 'Assessment submitted.'
  });
});

// ─── GET: My Sessions ─────────────────────────────────────────────────────────
router.get('/sessions', requireAuth, requireKinMember, (req, res) => {
  const db = getDb();
  const sessions = db.prepare(`
    SELECT bs.id, bs.scheduled_at, bs.duration_mins, bs.status, bs.payment_status, bs.amount, bs.feedback_given,
           u.name_enc AS mentor_name_enc,
           mp.avg_rating, mp.specializations
    FROM booking_sessions bs
    JOIN users u ON u.id = bs.mentor_id
    JOIN kinmentor_profiles mp ON mp.user_id = bs.mentor_id
    WHERE bs.member_id = ?
    ORDER BY bs.scheduled_at DESC
  `).all(req.user.id);

  return res.json({
    success: true,
    sessions: sessions.map(s => ({
      id: s.id,
      scheduledAt: s.scheduled_at,
      durationMins: s.duration_mins,
      status: s.status,
      paymentStatus: s.payment_status,
      amount: s.amount,
      feedbackGiven: !!s.feedback_given,
      mentorName: decrypt(s.mentor_name_enc),
      mentorRating: s.avg_rating,
      specializations: s.specializations
    }))
  });
});

// ─── GET: My Chat Messages ────────────────────────────────────────────────────
router.get('/messages/:mentorId', requireAuth, requireKinMember, (req, res) => {
  const db = getDb();
  const msgs = db.prepare(`
    SELECT cm.id, cm.sender_id, cm.message_enc, cm.is_read, cm.created_at,
           u.role AS sender_role
    FROM chat_messages cm
    JOIN users u ON u.id = cm.sender_id
    WHERE (cm.sender_id = ? AND cm.receiver_id = ?)
       OR (cm.sender_id = ? AND cm.receiver_id = ?)
    ORDER BY cm.created_at ASC
  `).all(req.user.id, req.params.mentorId, req.params.mentorId, req.user.id);

  // Mark as read
  db.prepare('UPDATE chat_messages SET is_read = 1 WHERE receiver_id = ? AND sender_id = ?')
    .run(req.user.id, req.params.mentorId);

  return res.json({
    success: true,
    messages: msgs.map(m => ({
      id: m.id,
      senderId: m.sender_id,
      senderRole: m.sender_role,
      message: decrypt(m.message_enc),
      isRead: !!m.is_read,
      createdAt: m.created_at,
      isMine: m.sender_id === req.user.id
    }))
  });
});

// ─── POST: Send Message ───────────────────────────────────────────────────────
router.post('/messages/:mentorId', requireAuth, requireKinMember,
  [body('message').trim().isLength({ min: 1, max: 2000 })],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

    const db = getDb();
    // Verify mentor exists and is assigned
    const profile = db.prepare('SELECT assigned_mentor_id FROM kinmember_profiles WHERE user_id = ?').get(req.user.id);
    if (!profile || String(profile.assigned_mentor_id) !== String(req.params.mentorId)) {
      return res.status(403).json({ success: false, message: 'You can only message your assigned KinMentor.' });
    }

    db.prepare('INSERT INTO chat_messages (sender_id, receiver_id, message_enc) VALUES (?, ?, ?)')
      .run(req.user.id, req.params.mentorId, encrypt(req.body.message));

    return res.status(201).json({ success: true, message: 'Message sent.' });
  }
);

// ─── GET: My Homework ─────────────────────────────────────────────────────────
router.get('/homework', requireAuth, requireKinMember, (req, res) => {
  const db = getDb();
  const tasks = db.prepare(`
    SELECT h.id, h.task_enc, h.due_date, h.is_completed, h.created_at,
           u.name_enc AS mentor_name_enc
    FROM homework h JOIN users u ON u.id = h.mentor_id
    WHERE h.member_id = ? ORDER BY h.created_at DESC
  `).all(req.user.id);

  return res.json({
    success: true,
    homework: tasks.map(t => ({
      id: t.id,
      task: decrypt(t.task_enc),
      dueDate: t.due_date,
      isCompleted: !!t.is_completed,
      mentorName: decrypt(t.mentor_name_enc),
      createdAt: t.created_at
    }))
  });
});

// ─── PATCH: Mark Homework Complete ───────────────────────────────────────────
router.patch('/homework/:id/complete', requireAuth, requireKinMember, (req, res) => {
  const db = getDb();
  db.prepare('UPDATE homework SET is_completed = 1 WHERE id = ? AND member_id = ?').run(req.params.id, req.user.id);
  return res.json({ success: true, message: 'Homework marked complete.' });
});

// ─── GET: My Resources ────────────────────────────────────────────────────────
router.get('/resources', requireAuth, requireKinMember, (req, res) => {
  const db = getDb();
  const profile = db.prepare('SELECT family_structure, child_status FROM kinmember_profiles WHERE user_id = ?').get(req.user.id);

  // Return resources relevant to their profile
  const resources = db.prepare(`
    SELECT * FROM resources WHERE is_active = 1
    ORDER BY created_at DESC
  `).all();

  return res.json({ success: true, resources });
});

// ─── POST: Submit Feedback after Session ─────────────────────────────────────
router.post('/feedback', requireAuth, requireKinMember,
  [body('sessionId').isInt(), body('rating').isInt({ min: 1, max: 5 })],
  (req, res) => {
    const { sessionId, rating, comment, isPublic } = req.body;
    const db = getDb();

    const session = db.prepare('SELECT * FROM booking_sessions WHERE id = ? AND member_id = ?').get(sessionId, req.user.id);
    if (!session) return res.status(404).json({ success: false, message: 'Session not found.' });
    if (session.feedback_given) return res.status(409).json({ success: false, message: 'Feedback already submitted.' });

    db.prepare('INSERT INTO feedback (session_id, member_id, mentor_id, rating, comment_enc, is_public) VALUES (?, ?, ?, ?, ?, ?)')
      .run(sessionId, req.user.id, session.mentor_id, rating, comment ? encrypt(comment) : null, isPublic ? 1 : 0);

    db.prepare('UPDATE booking_sessions SET feedback_given = 1 WHERE id = ?').run(sessionId);

    // Recompute mentor avg rating
    const avgRow = db.prepare('SELECT AVG(rating) AS avg, COUNT(*) AS cnt FROM feedback WHERE mentor_id = ?').get(session.mentor_id);
    db.prepare('UPDATE kinmentor_profiles SET avg_rating = ?, total_reviews = ? WHERE user_id = ?')
      .run(avgRow.avg || 0, avgRow.cnt || 0, session.mentor_id);

    return res.status(201).json({ success: true, message: 'Thank you for your feedback!' });
  }
);

// ─── POST: Request a Session ──────────────────────────────────────────────────
// Member requests a session with a mentor. Status = 'pending' until admin approves.
router.post('/session-request', requireAuth, requireKinMember,
  [
    body('mentorId').isInt({ min: 1 }).withMessage('Invalid mentor.'),
    body('durationMins').isIn([30, 60]).withMessage('Duration must be 30 or 60 minutes.'),
    body('message').optional({ nullable: true }).trim().isLength({ max: 500 })
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

    const { mentorId, durationMins, message } = req.body;
    const db = getDb();

    // Verify mentor exists and is active
    const mentor = db.prepare(
      "SELECT u.id, u.name_enc, u.email FROM users u JOIN kinmentor_profiles kp ON kp.user_id = u.id WHERE u.id = ? AND u.role = 'kinmentor' AND u.is_active = 1"
    ).get(mentorId);
    if (!mentor) return res.status(404).json({ success: false, message: 'KinMentor not found or unavailable.' });

    // Check for duplicate pending request (same member + mentor)
    const dup = db.prepare(
      "SELECT id FROM booking_sessions WHERE member_id = ? AND mentor_id = ? AND status = 'pending'"
    ).get(req.user.id, mentorId);
    if (dup) return res.status(409).json({ success: false, message: 'You already have a pending session request with this KinMentor. Please wait for admin approval.' });

    const notesEnc = message ? encrypt(message) : null;
    const result = db.prepare(`
      INSERT INTO booking_sessions
        (member_id, mentor_id, duration_mins, status, payment_status, notes_enc, created_at, updated_at)
      VALUES (?, ?, ?, 'pending', 'pending', ?, unixepoch(), unixepoch())
    `).run(req.user.id, mentorId, durationMins, notesEnc);

    // Notify admin(s) by email
    try {
      const member = db.prepare('SELECT name_enc FROM users WHERE id = ?').get(req.user.id);
      const adminEmails = (process.env.ADMIN_EMAIL_IDS || process.env.ADMIN_EMAIL || '').split(',').map(e => e.trim()).filter(Boolean);
      adminEmails.forEach(email => {
        sendSessionRequestedEmail(
          email,
          decrypt(member.name_enc),
          decrypt(mentor.name_enc),
          durationMins,
          message || null
        ).catch(console.error);
      });
    } catch(e) { console.error('[mail] session-request:', e.message); }

    return res.status(201).json({ success: true, sessionId: result.lastInsertRowid, message: 'Session request submitted. You will be notified once it is approved.' });
  }
);

// ─── GET: My Session Requests ─────────────────────────────────────────────────
router.get('/session-requests', requireAuth, requireKinMember, (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT bs.id, bs.mentor_id, bs.duration_mins, bs.status, bs.payment_status,
           bs.scheduled_at, bs.video_room, bs.created_at,
           u.name_enc AS mentor_name_enc
    FROM booking_sessions bs
    JOIN users u ON u.id = bs.mentor_id
    WHERE bs.member_id = ?
    ORDER BY bs.created_at DESC
  `).all(req.user.id);

  return res.json({
    success: true,
    sessions: rows.map(r => ({
      id: r.id,
      mentorId: r.mentor_id,
      mentorName: decrypt(r.mentor_name_enc),
      durationMins: r.duration_mins,
      status: r.status,
      paymentStatus: r.payment_status,
      scheduledAt: r.scheduled_at,
      videoRoom: r.video_room,
      createdAt: r.created_at
    }))
  });
});

// ─── POST: Quick Exit SOS Trigger ─────────────────────────────────────────────
router.post('/sos/quick-exit', requireAuth, (req, res) => {
  const db = getDb();
  db.prepare('INSERT INTO sos_events (user_id, trigger_type) VALUES (?, ?)').run(req.user.id, 'quick_exit');
  return res.json({ success: true });
});

module.exports = router;
