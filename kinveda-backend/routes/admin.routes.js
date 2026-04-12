/**
 * KinVeda Admin Routes
 * ⚠️  These routes are mounted at the OBFUSCATED prefix defined in ADMIN_ROUTE_PREFIX.
 * The /admin path is NOT exposed on the public site.
 * URL is shared only via the Admin SOP document.
 */
const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { getDb } = require('../config/database');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { encrypt, decrypt, encryptJSON, decryptJSON } = require('../middleware/encrypt');
const {
  sendSessionScheduledEmail, sendSessionConfirmation,
  sendMentorPayoutInvoice, sendPaymentConfirmationEmail,
  sendSessionApprovedEmail, sendSessionRequestedEmail
} = require('../config/mailer');
const ADMIN_EMAILS = (process.env.ADMIN_EMAIL_IDS || process.env.ADMIN_EMAIL || '').split(',').map(e => e.trim()).filter(Boolean);

// All admin routes require auth + admin role
router.use(requireAuth, requireAdmin);

// ─── Audit Logger ─────────────────────────────────────────────────────────────
function auditLog(db, adminId, action, targetType, targetId, details, ip) {
  db.prepare('INSERT INTO admin_log (admin_id, action, target_type, target_id, details_enc, ip_address) VALUES (?, ?, ?, ?, ?, ?)')
    .run(adminId, action, targetType, targetId, details ? encrypt(JSON.stringify(details)) : null, ip || null);
}

// ─── DASHBOARD STATS ─────────────────────────────────────────────────────────
router.get('/stats', (req, res) => {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const monthStart = now - 30 * 24 * 60 * 60;

  const stats = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM users WHERE role = 'kinmember')  AS total_kinmembers,
      (SELECT COUNT(*) FROM users WHERE role = 'kinmentor')  AS total_kinmentors,
      (SELECT COUNT(*) FROM users WHERE created_at > ?)      AS new_users_month,
      (SELECT COUNT(*) FROM booking_sessions)                AS total_sessions,
      (SELECT COUNT(*) FROM booking_sessions WHERE status = 'completed') AS completed_sessions,
      (SELECT COUNT(*) FROM booking_sessions WHERE status = 'pending')   AS pending_sessions,
      (SELECT COUNT(*) FROM booking_sessions WHERE status = 'completed' AND scheduled_at > ?) AS sessions_month,
      (SELECT COALESCE(SUM(amount),0) FROM booking_sessions WHERE status = 'completed') AS total_revenue,
      (SELECT COALESCE(SUM(amount),0) FROM booking_sessions WHERE status = 'completed' AND scheduled_at > ?) AS monthly_revenue,
      (SELECT COUNT(*) FROM sos_events WHERE status = 'active') AS open_sos,
      (SELECT COUNT(*) FROM kinmentor_profiles WHERE is_rci_verified = 0 AND is_profile_public = 0) AS pending_mentor_verifications
  `).get(monthStart, monthStart, monthStart);

  return res.json({ success: true, stats });
});

// ─── LIST ALL USERS ───────────────────────────────────────────────────────────
router.get('/users', (req, res) => {
  const db = getDb();
  const { role, page = 1, limit = 20 } = req.query;
  const offset = (page - 1) * limit;
  const whereClause = role ? `WHERE u.role = '${role}'` : '';

  const users = db.prepare(`
    SELECT u.id, u.email, u.role, u.name_enc, u.city_enc, u.phone_enc, u.is_verified, u.is_active, u.created_at, u.last_login,
           kmp.is_rci_verified, kmp.is_payment_verified, kmp.avg_rating, kmp.total_sessions AS mentor_session_count, kmp.total_earned,
           kmb.assigned_mentor_id, kmb.family_structure, kmb.child_status, kmb.primary_concerns_enc,
           (SELECT COUNT(*) FROM booking_sessions bs WHERE bs.member_id = u.id AND u.role = 'kinmember') AS member_session_count
    FROM users u
    LEFT JOIN kinmentor_profiles kmp ON kmp.user_id = u.id AND u.role = 'kinmentor'
    LEFT JOIN kinmember_profiles kmb ON kmb.user_id = u.id AND u.role = 'kinmember'
    ${whereClause}
    ORDER BY u.created_at DESC LIMIT ? OFFSET ?
  `).all(limit, offset);

  return res.json({
    success: true,
    users: users.map(u => ({
      id: u.id,
      email: u.email,
      role: u.role,
      name: decrypt(u.name_enc),
      city: decrypt(u.city_enc),
      phone: decrypt(u.phone_enc),
      isVerified: !!u.is_verified,
      isActive: !!u.is_active,
      createdAt: u.created_at,
      lastLogin: u.last_login,
      // KinMentor fields
      is_rci_verified: !!u.is_rci_verified,
      is_payment_verified: !!u.is_payment_verified,
      avg_rating: u.avg_rating,
      total_earned: u.total_earned ?? 0,
      // KinMember fields
      assigned_mentor_id: u.assigned_mentor_id ?? null,
      family_structure: u.family_structure,
      child_status: u.child_status,
      primary_concerns: decryptJSON(u.primary_concerns_enc) || [],
      // Session count — correct field per role
      session_count: u.role === 'kinmember' ? (u.member_session_count ?? 0) : (u.mentor_session_count ?? 0)
    }))
  });
});

// ─── GET: Pending Requests (unmatched KinMembers) ────────────────────────────
router.get('/requests/pending', (req, res) => {
  const db = getDb();
  const requests = db.prepare(`
    SELECT u.id, u.email, u.name_enc, u.city_enc, u.created_at,
           kp.family_structure, kp.child_status, kp.primary_concerns_enc, kp.assessment_completed,
           a.score AS assessment_score, a.sos_triggered
    FROM users u
    JOIN kinmember_profiles kp ON kp.user_id = u.id
    LEFT JOIN assessments a ON a.user_id = u.id
    WHERE u.role = 'kinmember' AND u.is_active = 1
      AND kp.assigned_mentor_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM booking_sessions bs
        WHERE bs.member_id = u.id AND bs.status IN ('pending','confirmed')
      )
    ORDER BY a.sos_triggered DESC, u.created_at ASC
  `).all();

  return res.json({
    success: true,
    requests: requests.map(r => ({
      id: r.id,
      email: r.email,
      name: decrypt(r.name_enc),
      city: decrypt(r.city_enc),
      familyStructure: r.family_structure,
      childStatus: r.child_status,
      primaryConcerns: decryptJSON(r.primary_concerns_enc) || [],
      assessmentCompleted: !!r.assessment_completed,
      assessmentScore: r.assessment_score,
      sosTriggered: !!r.sos_triggered,
      createdAt: r.created_at
    }))
  });
});

// ─── POST: Match Member to Mentor + Send Invite ────────────────────────────
router.post('/match', [body('memberId').isInt(), body('mentorId').isInt()], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

  const { memberId, mentorId } = req.body;
  const db = getDb();

  db.prepare('UPDATE kinmember_profiles SET assigned_mentor_id = ?, updated_at = unixepoch() WHERE user_id = ?')
    .run(mentorId, memberId);

  auditLog(db, req.user.id, 'MATCH_MEMBER_MENTOR', 'user', memberId, { mentorId }, req.ip);

  // Send notification emails to member, mentor, and admin
  const member = db.prepare('SELECT email, name_enc FROM users WHERE id = ?').get(memberId);
  const mentor = db.prepare('SELECT email, name_enc FROM users WHERE id = ?').get(mentorId);
  const memberName = decrypt(member?.name_enc) || 'KinMember';
  const mentorName = decrypt(mentor?.name_enc) || 'KinMentor';
  if (member?.email) sendSessionApprovedEmail(member.email, memberName, mentorName, null, null, 'member').catch(console.error);
  if (mentor?.email) sendSessionApprovedEmail(mentor.email, mentorName, memberName, null, null, 'mentor').catch(console.error);
  ADMIN_EMAILS.forEach(e => sendSessionRequestedEmail(e, memberName, mentorName, null, `Admin matched ${memberName} → ${mentorName}`).catch(console.error));

  return res.json({ success: true, message: `KinMember #${memberId} matched to KinMentor #${mentorId}.` });
});

// ─── GET: SOS Events ─────────────────────────────────────────────────────────
router.get('/sos', (req, res) => {
  const db = getDb();
  const events = db.prepare(`
    SELECT se.id, se.user_id, se.trigger_type, se.status, se.created_at, se.resolved_at,
           u.name_enc, u.email
    FROM sos_events se
    LEFT JOIN users u ON u.id = se.user_id
    ORDER BY se.created_at DESC LIMIT 50
  `).all();

  return res.json({
    success: true,
    events: events.map(e => ({
      id: e.id,
      userId: e.user_id,
      userName: decrypt(e.name_enc) || 'Anonymous',
      userEmail: e.email,
      triggerType: e.trigger_type,
      status: e.status,
      createdAt: e.created_at,
      resolvedAt: e.resolved_at
    }))
  });
});

// ─── PATCH: Resolve SOS ───────────────────────────────────────────────────────
router.patch('/sos/:id/resolve', (req, res) => {
  const db = getDb();
  db.prepare('UPDATE sos_events SET status = ?, resolved_by = ?, resolved_at = unixepoch() WHERE id = ?')
    .run('resolved', req.user.id, req.params.id);
  auditLog(db, req.user.id, 'RESOLVE_SOS', 'sos_events', req.params.id, null, req.ip);
  return res.json({ success: true, message: 'SOS event marked resolved.' });
});

// ─── PATCH: Verify KinMentor ──────────────────────────────────────────────────
router.patch('/mentor/:userId/verify', (req, res) => {
  const { rciVerified, paymentVerified } = req.body;
  const db = getDb();
  db.prepare(`
    UPDATE kinmentor_profiles SET
      is_rci_verified = COALESCE(?, is_rci_verified),
      is_payment_verified = COALESCE(?, is_payment_verified),
      is_profile_public = CASE WHEN COALESCE(?, is_rci_verified) = 1 AND COALESCE(?, is_payment_verified) = 1 THEN 1 ELSE is_profile_public END,
      updated_at = unixepoch()
    WHERE user_id = ?
  `).run(
    rciVerified !== undefined ? (rciVerified ? 1 : 0) : null,
    paymentVerified !== undefined ? (paymentVerified ? 1 : 0) : null,
    rciVerified !== undefined ? (rciVerified ? 1 : 0) : null,
    paymentVerified !== undefined ? (paymentVerified ? 1 : 0) : null,
    req.params.userId
  );
  auditLog(db, req.user.id, 'VERIFY_MENTOR', 'user', req.params.userId, { rciVerified, paymentVerified }, req.ip);
  return res.json({ success: true, message: 'KinMentor verification updated.' });
});

// ─── PATCH: Suspend / Activate User ──────────────────────────────────────────
router.patch('/users/:id/status', (req, res) => {
  const { isActive } = req.body;
  const db = getDb();
  db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(isActive ? 1 : 0, req.params.id);
  auditLog(db, req.user.id, isActive ? 'ACTIVATE_USER' : 'SUSPEND_USER', 'user', req.params.id, null, req.ip);
  return res.json({ success: true });
});

// ─── GET: Revenue Analytics ───────────────────────────────────────────────────
router.get('/revenue', (req, res) => {
  const db = getDb();
  const monthly = db.prepare(`
    SELECT strftime('%Y-%m', datetime(scheduled_at, 'unixepoch')) AS month,
           COUNT(*) AS sessions,
           COALESCE(SUM(amount), 0) AS revenue
    FROM booking_sessions WHERE status = 'completed'
    GROUP BY month ORDER BY month DESC LIMIT 12
  `).all();

  const byMentor = db.prepare(`
    SELECT bs.mentor_id, u.name_enc,
           COUNT(*) AS sessions,
           COALESCE(SUM(bs.amount), 0) AS revenue
    FROM booking_sessions bs JOIN users u ON u.id = bs.mentor_id
    WHERE bs.status = 'completed'
    GROUP BY bs.mentor_id ORDER BY revenue DESC LIMIT 10
  `).all();

  return res.json({
    success: true,
    monthly,
    byMentor: byMentor.map(m => ({ ...m, mentorName: decrypt(m.name_enc), name_enc: undefined }))
  });
});

// ─── GET: Demographics ────────────────────────────────────────────────────────
router.get('/demographics', (req, res) => {
  const db = getDb();
  const familyTypes = db.prepare(`
    SELECT family_structure, COUNT(*) AS count FROM kinmember_profiles GROUP BY family_structure
  `).all();
  const childStatus = db.prepare(`
    SELECT child_status, COUNT(*) AS count FROM kinmember_profiles GROUP BY child_status
  `).all();
  return res.json({ success: true, familyTypes, childStatus });
});

// ─── GET: Contact Enquiries ───────────────────────────────────────────────────
router.get('/enquiries', (req, res) => {
  const db = getDb();
  const enquiries = db.prepare(`
    SELECT id, name_enc, email_enc, message_enc, source_page, email_sent, created_at
    FROM contact_enquiries ORDER BY created_at DESC LIMIT 50
  `).all();

  return res.json({
    success: true,
    enquiries: enquiries.map(e => ({
      id: e.id,
      name: decrypt(e.name_enc),
      email: decrypt(e.email_enc),
      message: decrypt(e.message_enc),
      sourcePage: e.source_page,
      emailSent: !!e.email_sent,
      createdAt: e.created_at
    }))
  });
});

// ─── GET: All Sessions ────────────────────────────────────────────────────────
router.get('/sessions', (req, res) => {
  const db = getDb();
  const sessions = db.prepare(`
    SELECT bs.id, bs.scheduled_at, bs.duration_mins, bs.status, bs.payment_status, bs.amount,
           um.name_enc AS member_name_enc, um.email AS member_email,
           ut.name_enc AS mentor_name_enc, ut.email AS mentor_email
    FROM booking_sessions bs
    JOIN users um ON um.id = bs.member_id
    JOIN users ut ON ut.id = bs.mentor_id
    ORDER BY bs.scheduled_at DESC LIMIT 100
  `).all();

  return res.json({
    success: true,
    sessions: sessions.map(s => ({
      id: s.id,
      scheduledAt: s.scheduled_at,
      durationMins: s.duration_mins,
      status: s.status,
      paymentStatus: s.payment_status,
      amount: s.amount,
      memberName: decrypt(s.member_name_enc),
      memberEmail: s.member_email,
      mentorName: decrypt(s.mentor_name_enc),
      mentorEmail: s.mentor_email
    }))
  });
});

// ─── GET: Pending Session Requests ───────────────────────────────────────────
router.get('/sessions/pending', (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT bs.id, bs.member_id, bs.mentor_id, bs.duration_mins, bs.notes_enc, bs.created_at,
           um.name_enc AS member_name_enc, um.email AS member_email,
           ut.name_enc AS mentor_name_enc, ut.email AS mentor_email
    FROM booking_sessions bs
    JOIN users um ON um.id = bs.member_id
    JOIN users ut ON ut.id = bs.mentor_id
    WHERE bs.status = 'pending'
    ORDER BY bs.created_at ASC
  `).all();

  return res.json({
    success: true,
    requests: rows.map(r => ({
      id: r.id,
      memberId: r.member_id,
      mentorId: r.mentor_id,
      durationMins: r.duration_mins,
      memberName: decrypt(r.member_name_enc),
      memberEmail: r.member_email,
      mentorName: decrypt(r.mentor_name_enc),
      mentorEmail: r.mentor_email,
      message: r.notes_enc ? decrypt(r.notes_enc) : null,
      createdAt: r.created_at
    }))
  });
});

// ─── PATCH: Approve Session Request (admin sets date/time, optionally reassigns mentor) ────
router.patch('/sessions/:id/approve',
  [body('scheduledAt').isInt({ min: 1 }).withMessage('Valid scheduled timestamp required.')],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

    const sessionId = parseInt(req.params.id);
    const { scheduledAt, assignedMentorId } = req.body;
    const db = getDb();
    const crypto = require('crypto');

    // Load the pending session
    let session = db.prepare(`
      SELECT bs.*, um.name_enc AS member_name_enc, um.email AS member_email,
             ut.name_enc AS mentor_name_enc, ut.email AS mentor_email
      FROM booking_sessions bs
      JOIN users um ON um.id = bs.member_id
      JOIN users ut ON ut.id = bs.mentor_id
      WHERE bs.id = ? AND bs.status = 'pending'
    `).get(sessionId);

    if (!session) return res.status(404).json({ success: false, message: 'Pending session request not found.' });

    // If admin is reassigning to a different mentor, validate and apply
    let finalMentorId = session.mentor_id;
    if (assignedMentorId && parseInt(assignedMentorId) !== session.mentor_id) {
      const newMentor = db.prepare(
        'SELECT name_enc, email FROM users WHERE id = ? AND role = ? AND is_active = 1'
      ).get(parseInt(assignedMentorId), 'kinmentor');
      if (!newMentor) return res.status(400).json({ success: false, message: 'Selected mentor not found or inactive.' });
      finalMentorId = parseInt(assignedMentorId);
      // Override session fields so emails go to the assigned mentor
      session = {
        ...session,
        mentor_id: finalMentorId,
        mentor_name_enc: newMentor.name_enc,
        mentor_email: newMentor.email
      };
    }

    const roomName = `kv-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const now = Math.floor(Date.now() / 1000);

    db.prepare(`
      UPDATE booking_sessions
      SET status = 'confirmed', scheduled_at = ?, video_room = ?,
          mentor_id = ?, payment_status = 'pending', updated_at = ?
      WHERE id = ?
    `).run(scheduledAt, roomName, finalMentorId, now, sessionId);

    // Create video session entry
    db.prepare('INSERT OR IGNORE INTO video_sessions (session_id, room_name, created_at) VALUES (?, ?, ?)').run(sessionId, roomName, now);

    auditLog(db, req.user.id, 'APPROVE_SESSION', 'booking_sessions', sessionId,
      { scheduledAt, assignedMentorId: finalMentorId }, req.ip);

    // Send approval email to member
    try {
      sendSessionApprovedEmail(
        session.member_email,
        decrypt(session.member_name_enc),
        decrypt(session.mentor_name_enc),
        scheduledAt,
        session.duration_mins,
        'kinmember'
      ).catch(console.error);
    } catch(e) { console.error('[mail] approve→member:', e.message); }

    // Send approval email to assigned mentor
    try {
      sendSessionApprovedEmail(
        session.mentor_email,
        decrypt(session.mentor_name_enc),
        decrypt(session.member_name_enc),
        scheduledAt,
        session.duration_mins,
        'kinmentor'
      ).catch(console.error);
    } catch(e) { console.error('[mail] approve→mentor:', e.message); }

    return res.json({ success: true, sessionId, videoRoom: roomName, assignedMentorId: finalMentorId });
  }
);

// ─── PATCH: Update Session Status (cancel/etc) ───────────────────────────────
router.patch('/sessions/:id/status', [body('status').isIn(['cancelled','confirmed','completed'])], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  db.prepare('UPDATE booking_sessions SET status = ?, updated_at = ? WHERE id = ?')
    .run(req.body.status, now, req.params.id);
  auditLog(db, req.user.id, 'UPDATE_SESSION_STATUS', 'booking_sessions', req.params.id, { status: req.body.status }, req.ip);
  res.json({ success: true });
});

// ─── POST: Add Resource to Library ───────────────────────────────────────────
router.post('/resources', [body('title').trim().isLength({ min: 3 })], (req, res) => {
  const { title, description, category, fileUrl, targetFamilyType } = req.body;
  const db = getDb();
  const result = db.prepare('INSERT INTO resources (title, description, category, file_url, target_family_type, created_by) VALUES (?, ?, ?, ?, ?, ?)')
    .run(title, description, category, fileUrl, targetFamilyType, req.user.id);
  auditLog(db, req.user.id, 'CREATE_RESOURCE', 'resources', result.lastInsertRowid, { title }, req.ip);
  return res.status(201).json({ success: true, resourceId: result.lastInsertRowid });
});

// ─── PAYOUTS ─────────────────────────────────────────────────────────────────
// GET /payouts — list pending and processed payouts
router.get('/payouts', (req, res) => {
  const db = getDb();
  const payouts = db.prepare(`
    SELECT p.id, p.mentor_id, p.session_id, p.gross_amount, p.platform_cut_pct,
           p.payout_amount, p.status, p.transfer_ref, p.notes, p.processed_at, p.created_at,
           u.email AS mentor_email, u.name_enc AS mentor_name_enc,
           bs.scheduled_at, bs.duration_mins
    FROM payouts p
    JOIN users u ON u.id = p.mentor_id
    LEFT JOIN booking_sessions bs ON bs.id = p.session_id
    ORDER BY p.created_at DESC
    LIMIT 100
  `).all();

  res.json({
    success: true,
    payouts: payouts.map(p => ({
      ...p,
      mentorName: decrypt(p.mentor_name_enc),
      mentor_name_enc: undefined
    }))
  });
});

// GET /payouts/pending-sessions — completed sessions needing payout
router.get('/payouts/pending-sessions', (req, res) => {
  const db = getDb();
  const sessions = db.prepare(`
    SELECT bs.id, bs.scheduled_at, bs.duration_mins, bs.amount, bs.payment_status,
           um.email AS member_email, um.name_enc AS member_name_enc,
           ut.id AS mentor_id, ut.email AS mentor_email, ut.name_enc AS mentor_name_enc,
           (SELECT COUNT(*) FROM payouts WHERE session_id = bs.id AND status = 'processed') AS payout_done
    FROM booking_sessions bs
    JOIN users um ON um.id = bs.member_id
    JOIN users ut ON ut.id = bs.mentor_id
    WHERE bs.status = 'completed' AND bs.payment_status = 'paid'
    ORDER BY bs.scheduled_at DESC
    LIMIT 100
  `).all();

  res.json({
    success: true,
    sessions: sessions.map(s => ({
      ...s,
      memberName: decrypt(s.member_name_enc),
      mentorName: decrypt(s.mentor_name_enc),
      member_name_enc: undefined, mentor_name_enc: undefined,
      payoutDone: s.payout_done > 0
    }))
  });
});

// POST /payouts — create payout record (admin sends money to mentor)
router.post('/payouts', [
  body('mentorId').isInt(),
  body('sessionId').isInt(),
  body('grossAmount').isFloat({ min: 1 }),
  body('platformCutPct').isFloat({ min: 0, max: 100 })
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

  const { mentorId, sessionId, grossAmount, platformCutPct = 0, transferRef, notes } = req.body;
  const db = getDb();

  const payoutAmount = parseFloat(grossAmount) * (1 - platformCutPct / 100);
  const now = Math.floor(Date.now() / 1000);

  const result = db.prepare(`
    INSERT INTO payouts (admin_id, mentor_id, session_id, gross_amount, platform_cut_pct, payout_amount, status, transfer_ref, notes, processed_at)
    VALUES (?, ?, ?, ?, ?, ?, 'processed', ?, ?, ?)
  `).run(req.user.id, mentorId, sessionId, grossAmount, platformCutPct, payoutAmount, transferRef || null, notes || null, now);

  // Update mentor total_paid_out
  db.prepare(`
    UPDATE kinmentor_profiles SET total_paid_out = total_paid_out + ?, updated_at = unixepoch() WHERE user_id = ?
  `).run(payoutAmount, mentorId);

  auditLog(db, req.user.id, 'PAYOUT_MENTOR', 'payouts', result.lastInsertRowid,
    { mentorId, sessionId, grossAmount, platformCutPct, payoutAmount }, req.ip);

  res.json({ success: true, payoutId: result.lastInsertRowid, payoutAmount });
});

// ─── CONTENT CREATION ────────────────────────────────────────────────────────
router.get('/content', (req, res) => {
  const db = getDb();
  const content = db.prepare(`
    SELECT pc.id, pc.type, pc.title, pc.slug, pc.excerpt, pc.category, pc.is_published, pc.published_at, pc.created_at,
           u.name_enc AS author_name_enc
    FROM platform_content pc
    JOIN users u ON u.id = pc.admin_id
    ORDER BY pc.created_at DESC
    LIMIT 50
  `).all();
  res.json({ success: true, content: content.map(c => ({ ...c, authorName: decrypt(c.author_name_enc), author_name_enc: undefined })) });
});

router.post('/content', [
  body('title').trim().isLength({ min: 3 }),
  body('type').isIn(['blog', 'announcement', 'resource_page']),
  body('content').trim().isLength({ min: 10 })
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

  const { type, title, content, excerpt, category, isPublished } = req.body;
  const db  = getDb();
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') + '-' + Date.now();
  const now  = Math.floor(Date.now() / 1000);

  const result = db.prepare(`
    INSERT INTO platform_content (admin_id, type, title, slug, content, excerpt, category, is_published, published_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
  `).run(req.user.id, type, title, slug, content, excerpt || null, category || null,
    isPublished ? 1 : 0, isPublished ? now : null);

  auditLog(db, req.user.id, 'CREATE_CONTENT', 'platform_content', result.lastInsertRowid, { type, title }, req.ip);
  res.json({ success: true, contentId: result.lastInsertRowid, slug });
});

router.put('/content/:id', (req, res) => {
  const { title, content, excerpt, category, isPublished } = req.body;
  const db  = getDb();
  const now  = Math.floor(Date.now() / 1000);
  db.prepare(`
    UPDATE platform_content SET title = ?, content = ?, excerpt = ?, category = ?,
      is_published = ?, published_at = CASE WHEN ? = 1 AND published_at IS NULL THEN ? ELSE published_at END,
      updated_at = unixepoch()
    WHERE id = ?
  `).run(title, content, excerpt || null, category || null, isPublished ? 1 : 0, isPublished ? 1 : 0, now, req.params.id);
  res.json({ success: true });
});

router.delete('/content/:id', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM platform_content WHERE id = ?').run(req.params.id);
  auditLog(db, req.user.id, 'DELETE_CONTENT', 'platform_content', req.params.id, null, req.ip);
  res.json({ success: true });
});

// ─── ADMIN: Book a Session (with/without payment) ────────────────────────────
router.post('/sessions/book', [
  body('memberId').isInt(),
  body('mentorId').isInt(),
  body('scheduledAt').isInt(),
  body('durationMins').isInt({ min: 30 })
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

  const { memberId, mentorId, scheduledAt, durationMins, waivePayment, amount } = req.body;
  const db = getDb();
  const crypto = require('crypto');
  const roomName = `kv-adm-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const now = Math.floor(Date.now() / 1000);

  const result = db.prepare(`
    INSERT INTO booking_sessions
      (member_id, mentor_id, scheduled_at, duration_mins, status, payment_status, payment_waived, amount, video_room, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'confirmed', ?, ?, ?, ?, unixepoch(), unixepoch())
  `).run(memberId, mentorId, scheduledAt, durationMins,
    waivePayment ? 'waived' : 'unpaid', waivePayment ? 1 : 0, amount || 0, roomName);

  const sessionId = result.lastInsertRowid;

  // Mark member as matched (so they leave the Unmatched queue)
  db.prepare(`UPDATE kinmember_profiles SET assigned_mentor_id = ?, updated_at = unixepoch() WHERE user_id = ?`)
    .run(mentorId, memberId);

  // Create video session entry
  db.prepare(`
    INSERT INTO video_sessions (session_id, room_name, created_at) VALUES (?, ?, ?)
  `).run(sessionId, roomName, now);

  auditLog(db, req.user.id, 'ADMIN_BOOK_SESSION', 'booking_sessions', sessionId,
    { memberId, mentorId, waivePayment }, req.ip);

  // Notify KinMember by email that a session has been scheduled for them
  try {
    const member = db.prepare('SELECT email, name_enc FROM users WHERE id = ?').get(memberId);
    const mentor = db.prepare('SELECT name_enc FROM users WHERE id = ?').get(mentorId);
    if (member && mentor) {
      sendSessionScheduledEmail(
        member.email,
        decrypt(member.name_enc),
        decrypt(mentor.name_enc),
        scheduledAt,
        durationMins
      ).catch(console.error);
    }
  } catch (e) { console.error('[mail] session scheduled:', e.message); }

  res.json({ success: true, sessionId, videoRoom: roomName });
});

// ─── ADMIN: Upload recording link for a session ───────────────────────────────
router.patch('/sessions/:id/recording', (req, res) => {
  const { recordingUrl } = req.body;
  if (!recordingUrl) return res.status(400).json({ success: false, message: 'Recording URL required' });
  const db = getDb();
  db.prepare(`
    UPDATE video_sessions SET recording_url = ?, recording_uploaded_by = ? WHERE session_id = ?
  `).run(recordingUrl, req.user.id, req.params.id);
  auditLog(db, req.user.id, 'ADD_RECORDING', 'booking_sessions', req.params.id, { recordingUrl }, req.ip);
  res.json({ success: true });
});

// ─── ADMIN: Mark session complete ─────────────────────────────────────────────
router.patch('/sessions/:id/complete', (req, res) => {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    UPDATE booking_sessions SET status = 'completed', updated_at = ? WHERE id = ?
  `).run(now, req.params.id);

  // Update video session duration
  const vs = db.prepare('SELECT * FROM video_sessions WHERE session_id = ?').get(req.params.id);
  if (vs && vs.started_at) {
    db.prepare('UPDATE video_sessions SET ended_at = ?, duration_mins = ? WHERE session_id = ?')
      .run(now, Math.round((now - vs.started_at) / 60), req.params.id);
  }

  // Increment mentor total_sessions
  const sess = db.prepare('SELECT mentor_id, amount FROM booking_sessions WHERE id = ?').get(req.params.id);
  if (sess) {
    db.prepare(`UPDATE kinmentor_profiles SET total_sessions = total_sessions + 1, total_earned = total_earned + ?, updated_at = unixepoch() WHERE user_id = ?`)
      .run(sess.amount || 0, sess.mentor_id);
  }

  auditLog(db, req.user.id, 'COMPLETE_SESSION', 'booking_sessions', req.params.id, null, req.ip);
  res.json({ success: true });
});

// ─── MULTI-ADMIN: Create another admin ───────────────────────────────────────
// Accessed via the obfuscated admin URL — existing admin creates new admin accounts
router.post('/create-admin', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 10 }),
  body('name').trim().isLength({ min: 2 })
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

  const { email, password, name } = req.body;
  const db = getDb();
  const bcrypt = require('bcryptjs');

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (existing) return res.status(409).json({ success: false, message: 'Email already registered' });

  const passwordHash = await bcrypt.hash(password, 12);
  const result = db.prepare(`
    INSERT INTO users (email, password_hash, role, name_enc, signup_status, is_verified, created_at, updated_at)
    VALUES (?, ?, 'admin', ?, 'registered', 1, unixepoch(), unixepoch())
  `).run(email.toLowerCase(), passwordHash, encrypt(name));

  auditLog(db, req.user.id, 'CREATE_ADMIN', 'user', result.lastInsertRowid, { email }, req.ip);
  res.json({ success: true, message: `Admin account created for ${email}`, adminId: result.lastInsertRowid });
});

// ─── ADMIN: List all admins ───────────────────────────────────────────────────
router.get('/admins', (req, res) => {
  const db = getDb();
  const admins = db.prepare(`
    SELECT id, email, name_enc, created_at, last_login FROM users WHERE role = 'admin' ORDER BY created_at ASC
  `).all();
  res.json({ success: true, admins: admins.map(a => ({ ...a, name: decrypt(a.name_enc), name_enc: undefined })) });
});

// ─── TESTIMONIALS: Approve/reject ────────────────────────────────────────────
router.get('/testimonials', (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT t.id, t.user_id, t.rating, t.story_enc, t.author_display, t.concern_tag,
           t.is_approved, t.is_public, t.created_at, u.email
    FROM testimonials t LEFT JOIN users u ON u.id = t.user_id
    ORDER BY t.created_at DESC LIMIT 50
  `).all();
  res.json({ success: true, testimonials: rows.map(t => ({ ...t, story: decrypt(t.story_enc), story_enc: undefined })) });
});

router.patch('/testimonials/:id', (req, res) => {
  const { isApproved, isPublic } = req.body;
  const db = getDb();
  db.prepare(`
    UPDATE testimonials SET is_approved = ?, is_public = ?, approved_by = ? WHERE id = ?
  `).run(isApproved ? 1 : 0, isPublic ? 1 : 0, req.user.id, req.params.id);
  auditLog(db, req.user.id, 'APPROVE_TESTIMONIAL', 'testimonials', req.params.id, { isApproved, isPublic }, req.ip);
  res.json({ success: true });
});

// ─── MENTOR AVAILABILITY (admin view for matching) ────────────────────────────
router.get('/mentor/:userId/availability', (req, res) => {
  const db = getDb();
  const slots = db.prepare(`
    SELECT * FROM mentor_availability
    WHERE mentor_id = ? AND is_active = 1
    ORDER BY day_of_week, start_time
  `).all(req.params.userId);
  res.json({ success: true, slots });
});

// ─── PRE-REGISTERED USERS ────────────────────────────────────────────────────
router.get('/pre-registered', (req, res) => {
  const db = getDb();
  const users = db.prepare(`
    SELECT u.id, u.email, u.name_enc, u.created_at,
           (SELECT COUNT(*) FROM contact_enquiries WHERE user_id = u.id) AS enquiry_count
    FROM users u
    WHERE u.signup_status = 'pre_registered'
    ORDER BY u.created_at DESC LIMIT 50
  `).all();
  res.json({ success: true, users: users.map(u => ({ ...u, name: decrypt(u.name_enc), name_enc: undefined })) });
});

// ─── PAYMENT MANAGEMENT ──────────────────────────────────────────────────────

// GET /payment/member-receipts — all member payments (with mentor info)
router.get('/payment/member-receipts', (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT p.id, p.user_id, p.session_id, p.razorpay_payment_id, p.razorpay_order_id,
           p.amount_paise, p.status, p.payment_type, p.created_at,
           um.email AS member_email, um.name_enc AS member_name_enc,
           ut.email AS mentor_email, ut.name_enc AS mentor_name_enc,
           bs.scheduled_at, bs.duration_mins
    FROM payments p
    JOIN users um ON um.id = p.user_id
    LEFT JOIN booking_sessions bs ON bs.id = p.session_id
    LEFT JOIN users ut ON ut.id = bs.mentor_id
    WHERE p.status = 'paid'
    ORDER BY p.created_at DESC
    LIMIT 200
  `).all();

  res.json({
    success: true,
    receipts: rows.map(r => ({
      id:           r.id,
      memberEmail:  r.member_email,
      memberName:   decrypt(r.member_name_enc),
      mentorEmail:  r.mentor_email,
      mentorName:   r.mentor_name_enc ? decrypt(r.mentor_name_enc) : null,
      amountInr:    Math.round((r.amount_paise || 0) / 100),
      paymentId:    r.razorpay_payment_id,
      paymentType:  r.payment_type,
      sessionAt:    r.scheduled_at,
      paidAt:       r.created_at
    }))
  });
});

// PATCH /payment/session/:id/received — admin marks offline payment as received from member
router.patch('/payment/session/:id/received', (req, res) => {
  const db = getDb();
  const sessionId = parseInt(req.params.id);
  db.prepare(`UPDATE booking_sessions SET payment_status = 'paid', updated_at = unixepoch() WHERE id = ?`).run(sessionId);
  auditLog(db, req.user.id, 'MARK_PAYMENT_RECEIVED', 'booking_sessions', sessionId, null, req.ip);
  res.json({ success: true, message: 'Payment marked as received from member.' });
});

// POST /payouts/send-invoice — admin marks payout sent + emails invoice to mentor
router.post('/payouts/send-invoice', [
  body('mentorId').isInt(),
  body('grossAmount').isFloat({ min: 1 }),
  body('sessions').isInt({ min: 1 }),
  body('weekLabel').trim().isLength({ min: 3 })
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

  const { mentorId, grossAmount, sessions, weekLabel, transferRef, sessionIds } = req.body;
  const db    = getDb();
  const PLATFORM_CUT_PCT = 20;
  const platformCut  = parseFloat(grossAmount) * PLATFORM_CUT_PCT / 100;
  const payoutAmount = parseFloat(grossAmount) - platformCut;
  const now = Math.floor(Date.now() / 1000);

  const mentor = db.prepare(`
    SELECT u.email, u.name_enc, kp.payment_mode, kp.bank_holder_enc
    FROM users u JOIN kinmentor_profiles kp ON kp.user_id = u.id
    WHERE u.id = ?
  `).get(mentorId);
  if (!mentor) return res.status(404).json({ success: false, message: 'Mentor not found.' });

  // Record payout
  const result = db.prepare(`
    INSERT INTO payouts (admin_id, mentor_id, gross_amount, platform_cut_pct, payout_amount,
      status, transfer_ref, week_label, invoice_sent, payment_mode, processed_at, created_at)
    VALUES (?, ?, ?, ?, ?, 'processed', ?, ?, 1, ?, ?, unixepoch())
  `).run(
    req.user.id, mentorId, grossAmount, PLATFORM_CUT_PCT, payoutAmount,
    transferRef || null, weekLabel,
    mentor.payment_mode || 'offline', now
  );

  // Update mentor total_paid_out
  db.prepare(`UPDATE kinmentor_profiles SET total_paid_out = total_paid_out + ?, updated_at = unixepoch() WHERE user_id = ?`)
    .run(payoutAmount, mentorId);

  // Mark individual sessions' payouts if IDs provided
  if (Array.isArray(sessionIds) && sessionIds.length) {
    for (const sid of sessionIds) {
      db.prepare(`INSERT OR IGNORE INTO payouts (admin_id, mentor_id, session_id, gross_amount, platform_cut_pct, payout_amount, status, processed_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'processed', ?, unixepoch())`)
        .run(req.user.id, mentorId, sid, 0, PLATFORM_CUT_PCT, 0, now);
    }
  }

  auditLog(db, req.user.id, 'PAYOUT_INVOICE_SENT', 'payouts', result.lastInsertRowid,
    { mentorId, grossAmount, payoutAmount, weekLabel }, req.ip);

  // Email invoice to mentor
  try {
    await sendMentorPayoutInvoice(
      mentor.email,
      mentor.bank_holder_enc ? decrypt(mentor.bank_holder_enc) : decrypt(db.prepare('SELECT name_enc FROM users WHERE id = ?').get(mentorId)?.name_enc || ''),
      Math.round(grossAmount),
      Math.round(platformCut),
      Math.round(payoutAmount),
      weekLabel,
      sessions,
      transferRef || null,
      mentor.payment_mode || 'offline'
    );
  } catch (e) { console.error('[mail] payout invoice:', e.message); }

  res.json({ success: true, payoutId: result.lastInsertRowid, payoutAmount: Math.round(payoutAmount) });
});

// GET /mentor/:id/billing — admin view of a mentor's billing/bank details
router.get('/mentor/:id/billing', (req, res) => {
  const db = getDb();
  const row = db.prepare(`
    SELECT kp.payment_mode, kp.bank_account_enc, kp.bank_ifsc_enc, kp.bank_holder_enc,
           kp.bank_verified, kp.bank_verify_note
    FROM kinmentor_profiles kp WHERE kp.user_id = ?
  `).get(req.params.id);
  if (!row) return res.status(404).json({ success: false, message: 'Not found.' });

  res.json({
    success: true,
    billing: {
      paymentMode:  row.payment_mode || 'offline',
      bankAccount:  row.bank_account_enc ? decrypt(row.bank_account_enc) : '',
      bankIfsc:     row.bank_ifsc_enc    ? decrypt(row.bank_ifsc_enc)    : '',
      bankHolder:   row.bank_holder_enc  ? decrypt(row.bank_holder_enc)  : '',
      bankVerified: !!row.bank_verified,
      bankVerifyNote: row.bank_verify_note || ''
    }
  });
});

// PATCH /mentor/:id/billing/verify — admin verifies or rejects a mentor's bank account
router.patch('/mentor/:id/billing/verify', [
  body('verified').isBoolean(),
  body('note').optional().trim()
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

  const { verified, note } = req.body;
  const db = getDb();
  db.prepare(`UPDATE kinmentor_profiles SET bank_verified = ?, bank_verify_note = ?, updated_at = unixepoch() WHERE user_id = ?`)
    .run(verified ? 1 : 0, note || (verified ? 'Verified by admin' : 'Rejected by admin'), req.params.id);

  auditLog(db, req.user.id, verified ? 'BANK_VERIFIED' : 'BANK_REJECTED', 'kinmentor_profiles', req.params.id, { note }, req.ip);
  res.json({ success: true, message: verified ? 'Bank account verified.' : 'Bank account rejected.' });
});

// GET /mentors/summary — all mentors with earnings and payout summary for admin dashboard
router.get('/mentors/summary', (req, res) => {
  const db = getDb();
  const mentors = db.prepare(`
    SELECT u.id, u.email, u.name_enc, u.is_active, u.created_at,
           kp.total_earned, kp.total_paid_out, kp.payment_mode, kp.bank_verified,
           kp.avg_rating, kp.total_sessions, kp.is_rci_verified, kp.is_profile_public,
           (kp.total_earned - kp.total_paid_out) AS balance_due
    FROM users u
    JOIN kinmentor_profiles kp ON kp.user_id = u.id
    WHERE u.role = 'kinmentor'
    ORDER BY balance_due DESC, u.created_at DESC
  `).all();

  res.json({
    success: true,
    mentors: mentors.map(m => ({
      id:            m.id,
      email:         m.email,
      name:          decrypt(m.name_enc),
      isActive:      !!m.is_active,
      totalEarned:   m.total_earned || 0,
      totalPaidOut:  m.total_paid_out || 0,
      balanceDue:    m.balance_due || 0,
      paymentMode:   m.payment_mode || 'offline',
      bankVerified:  !!m.bank_verified,
      avgRating:     m.avg_rating || 0,
      totalSessions: m.total_sessions || 0,
      isRciVerified: !!m.is_rci_verified,
      isPublic:      !!m.is_profile_public,
      createdAt:     m.created_at
    }))
  });
});

module.exports = router;
