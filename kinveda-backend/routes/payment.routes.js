/**
 * KinVeda Payment Routes — Razorpay (INR)
 * POST /api/payment/order          – create Razorpay order (session payment)
 * POST /api/payment/verify         – verify payment signature
 * POST /api/payment/subscription   – create monthly package subscription
 * POST /api/payment/subscription/cancel – cancel subscription
 * GET  /api/payment/history        – KinMember billing history
 * GET  /api/payment/subscription   – active subscription details
 * POST /api/payment/webhook        – Razorpay webhook (raw body)
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { getDb } = require('../config/database');
const { requireAuth, requireKinMember } = require('../middleware/auth');
const { encrypt, decrypt } = require('../middleware/encrypt');

// ─── Razorpay instance ────────────────────────────────────────────────────────
function getRazorpay() {
  try {
    const Razorpay = require('razorpay');
    return new Razorpay({
      key_id:     process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET
    });
  } catch {
    console.error('[Payment] razorpay package not installed — run npm install razorpay');
    return null;
  }
}

// ─── Helper: verify Razorpay signature ────────────────────────────────────────
function verifySignature(orderId, paymentId, signature) {
  const body  = orderId + '|' + paymentId;
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || '')
    .update(body)
    .digest('hex');
  return expected === signature;
}

// ─── POST /api/payment/order ─────────────────────────────────────────────────
// Creates a Razorpay order for a single session payment
router.post('/order', requireAuth, requireKinMember, async (req, res) => {
  try {
    const { sessionId } = req.body;
    const db = getDb();
    const user = req.user;

    // Validate session belongs to this member and is unpaid
    const session = db.prepare(`
      SELECT bs.*, km.fee_30min, km.fee_60min
      FROM booking_sessions bs
      JOIN kinmentor_profiles km ON km.user_id = bs.mentor_id
      WHERE bs.id = ? AND bs.member_id = ?
    `).get(sessionId, user.id);

    if (!session) return res.status(404).json({ success: false, message: 'Session not found' });
    if (session.payment_status === 'paid' || session.payment_waived) {
      return res.status(400).json({ success: false, message: 'Session already paid' });
    }

    const amountINR = session.amount || (session.duration_mins <= 30 ? session.fee_30min : session.fee_60min);
    const amountPaise = Math.round(amountINR * 100);

    const rzp = getRazorpay();
    if (!rzp) return res.status(500).json({ success: false, message: 'Payment service unavailable' });

    const order = await rzp.orders.create({
      amount:   amountPaise,
      currency: 'INR',
      receipt:  `session_${sessionId}_${Date.now()}`,
      notes:    { sessionId: String(sessionId), memberId: String(user.id), type: 'session' }
    });

    // Store pending payment record
    db.prepare(`
      INSERT INTO payments (user_id, session_id, razorpay_order_id, amount_paise, currency, status, payment_type, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'INR', 'created', 'session', unixepoch(), unixepoch())
    `).run(user.id, sessionId, order.id, amountPaise);

    res.json({
      success:    true,
      orderId:    order.id,
      amount:     amountPaise,
      currency:   'INR',
      keyId:      process.env.RAZORPAY_KEY_ID,
      sessionId,
      memberName: user.name || '',
      memberEmail: user.email || ''
    });
  } catch (err) {
    console.error('[Payment] order error:', err);
    res.status(500).json({ success: false, message: 'Could not create payment order' });
  }
});

// ─── POST /api/payment/verify ────────────────────────────────────────────────
// Verifies Razorpay payment after frontend checkout completes
router.post('/verify', requireAuth, requireKinMember, (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, sessionId } = req.body;
    const db = getDb();

    if (!verifySignature(razorpay_order_id, razorpay_payment_id, razorpay_signature)) {
      return res.status(400).json({ success: false, message: 'Payment verification failed — invalid signature' });
    }

    const now = Math.floor(Date.now() / 1000);

    // Update payment record
    db.prepare(`
      UPDATE payments SET
        razorpay_payment_id = ?, razorpay_signature = ?,
        status = 'paid', updated_at = ?
      WHERE razorpay_order_id = ?
    `).run(razorpay_payment_id, razorpay_signature, now, razorpay_order_id);

    // Mark session as paid and confirmed
    db.prepare(`
      UPDATE booking_sessions
      SET payment_status = 'paid', status = 'confirmed', updated_at = ?
      WHERE id = ? AND member_id = ?
    `).run(now, sessionId, req.user.id);

    // Generate Jitsi room if not already set
    const session = db.prepare('SELECT * FROM booking_sessions WHERE id = ?').get(sessionId);
    if (session && !session.video_room) {
      const roomName = `kv-${sessionId}-${crypto.randomBytes(6).toString('hex')}`;
      db.prepare('UPDATE booking_sessions SET video_room = ? WHERE id = ?').run(roomName, sessionId);

      // Create video_sessions entry
      db.prepare(`
        INSERT OR IGNORE INTO video_sessions (session_id, room_name, created_at)
        VALUES (?, ?, ?)
      `).run(sessionId, roomName, now);
    }

    res.json({ success: true, message: 'Payment verified. Session confirmed.' });
  } catch (err) {
    console.error('[Payment] verify error:', err);
    res.status(500).json({ success: false, message: 'Verification error' });
  }
});

// ─── POST /api/payment/subscription ─────────────────────────────────────────
// Creates a monthly subscription order (one-time payment, tracked as subscription)
router.post('/subscription', requireAuth, requireKinMember, async (req, res) => {
  try {
    const { mentorId } = req.body;
    const db  = getDb();
    const user = req.user;

    // Check mentor fee
    const mentor = db.prepare(`
      SELECT u.id, u.email, km.fee_monthly
      FROM users u JOIN kinmentor_profiles km ON km.user_id = u.id
      WHERE u.id = ? AND km.is_profile_public = 1
    `).get(mentorId);

    if (!mentor || !mentor.fee_monthly) {
      return res.status(404).json({ success: false, message: 'KinMentor or package not found' });
    }

    // Check existing active subscription
    const existing = db.prepare(`
      SELECT id FROM subscriptions
      WHERE user_id = ? AND mentor_id = ? AND status = 'active'
    `).get(user.id, mentorId);
    if (existing) return res.status(400).json({ success: false, message: 'Active subscription already exists' });

    const amountPaise = Math.round(mentor.fee_monthly * 100);

    const rzp = getRazorpay();
    if (!rzp) return res.status(500).json({ success: false, message: 'Payment service unavailable' });

    // For simplicity, create a standard order (subscription-like; full Razorpay subscription needs plan setup)
    const order = await rzp.orders.create({
      amount:   amountPaise,
      currency: 'INR',
      receipt:  `sub_${user.id}_${mentorId}_${Date.now()}`,
      notes:    { type: 'subscription', memberId: String(user.id), mentorId: String(mentorId) }
    });

    // Create subscription record (status: 'created' until payment verified)
    const cycleStart = Math.floor(Date.now() / 1000);
    const cycleEnd = cycleStart + 30 * 24 * 3600;
    const subId = db.prepare(`
      INSERT INTO subscriptions
        (user_id, mentor_id, plan_name, amount_inr, status, sessions_included, billing_cycle_start, billing_cycle_end, created_at, updated_at)
      VALUES (?, ?, 'Monthly Care Package', ?, 'created', 8, ?, ?, unixepoch(), unixepoch())
    `).run(user.id, mentorId, mentor.fee_monthly, cycleStart, cycleEnd).lastInsertRowid;

    // Create pending payment
    db.prepare(`
      INSERT INTO payments (user_id, subscription_id, razorpay_order_id, amount_paise, currency, status, payment_type, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'INR', 'created', 'subscription', unixepoch(), unixepoch())
    `).run(user.id, subId, order.id, amountPaise);

    res.json({
      success:        true,
      orderId:        order.id,
      amount:         amountPaise,
      currency:       'INR',
      keyId:          process.env.RAZORPAY_KEY_ID,
      subscriptionId: subId,
      mentorId,
      memberName:     user.name || '',
      memberEmail:    user.email || ''
    });
  } catch (err) {
    console.error('[Payment] subscription error:', err);
    res.status(500).json({ success: false, message: 'Could not create subscription order' });
  }
});

// ─── POST /api/payment/subscription/verify ───────────────────────────────────
router.post('/subscription/verify', requireAuth, requireKinMember, (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, subscriptionId } = req.body;
    const db = getDb();

    if (!verifySignature(razorpay_order_id, razorpay_payment_id, razorpay_signature)) {
      return res.status(400).json({ success: false, message: 'Payment verification failed' });
    }

    const now = Math.floor(Date.now() / 1000);

    db.prepare(`
      UPDATE payments SET razorpay_payment_id = ?, razorpay_signature = ?, status = 'paid', updated_at = ?
      WHERE razorpay_order_id = ?
    `).run(razorpay_payment_id, razorpay_signature, now, razorpay_order_id);

    db.prepare(`
      UPDATE subscriptions SET status = 'active', updated_at = ? WHERE id = ? AND user_id = ?
    `).run(now, subscriptionId, req.user.id);

    // Mark member profile as package active
    db.prepare(`
      UPDATE kinmember_profiles SET package_active = 1, package_renewal_date = ?, updated_at = ?
      WHERE user_id = ?
    `).run(now + 30 * 24 * 3600, now, req.user.id);

    res.json({ success: true, message: 'Subscription activated!' });
  } catch (err) {
    console.error('[Payment] sub verify error:', err);
    res.status(500).json({ success: false, message: 'Verification error' });
  }
});

// ─── POST /api/payment/subscription/cancel ───────────────────────────────────
router.post('/subscription/cancel', requireAuth, requireKinMember, (req, res) => {
  try {
    const { subscriptionId, reason } = req.body;
    const db  = getDb();
    const now = Math.floor(Date.now() / 1000);

    const sub = db.prepare('SELECT * FROM subscriptions WHERE id = ? AND user_id = ?').get(subscriptionId, req.user.id);
    if (!sub) return res.status(404).json({ success: false, message: 'Subscription not found' });
    if (sub.status !== 'active') return res.status(400).json({ success: false, message: 'Subscription not active' });

    db.prepare(`
      UPDATE subscriptions SET status = 'cancelled', cancelled_at = ?, cancel_reason = ?, updated_at = ?
      WHERE id = ?
    `).run(now, reason || 'User cancelled', now, subscriptionId);

    db.prepare(`
      UPDATE kinmember_profiles SET package_active = 0, updated_at = ? WHERE user_id = ?
    `).run(now, req.user.id);

    res.json({ success: true, message: 'Subscription cancelled. Access continues until current period ends.' });
  } catch (err) {
    console.error('[Payment] cancel error:', err);
    res.status(500).json({ success: false, message: 'Cancellation error' });
  }
});

// ─── GET /api/payment/history ────────────────────────────────────────────────
router.get('/history', requireAuth, requireKinMember, (req, res) => {
  try {
    const db = getDb();

    const payments = db.prepare(`
      SELECT p.id, p.razorpay_payment_id, p.amount_paise, p.currency, p.status,
             p.payment_type, p.created_at,
             bs.scheduled_at, bs.duration_mins,
             u.email as mentor_email
      FROM payments p
      LEFT JOIN booking_sessions bs ON bs.id = p.session_id
      LEFT JOIN users u ON u.id = bs.mentor_id
      WHERE p.user_id = ?
      ORDER BY p.created_at DESC
      LIMIT 100
    `).all(req.user.id);

    const subscriptions = db.prepare(`
      SELECT s.*, u.email as mentor_email
      FROM subscriptions s
      LEFT JOIN users u ON u.id = s.mentor_id
      WHERE s.user_id = ?
      ORDER BY s.created_at DESC
    `).all(req.user.id);

    res.json({ success: true, payments, subscriptions });
  } catch (err) {
    console.error('[Payment] history error:', err);
    res.status(500).json({ success: false, message: 'Could not load billing history' });
  }
});

// ─── GET /api/payment/subscription ──────────────────────────────────────────
router.get('/subscription', requireAuth, requireKinMember, (req, res) => {
  try {
    const db = getDb();
    const sub = db.prepare(`
      SELECT s.*, u.email as mentor_email
      FROM subscriptions s
      LEFT JOIN users u ON u.id = s.mentor_id
      WHERE s.user_id = ? AND s.status = 'active'
      ORDER BY s.created_at DESC
      LIMIT 1
    `).get(req.user.id);

    res.json({ success: true, subscription: sub || null });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error loading subscription' });
  }
});

// ─── POST /api/payment/webhook ───────────────────────────────────────────────
// Razorpay sends events here — must use raw body for signature verification
router.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  try {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) return res.status(200).json({ received: true });

    const signature = req.headers['x-razorpay-signature'];
    const bodyStr   = typeof req.body === 'string' ? req.body : req.body.toString();
    const expected  = crypto.createHmac('sha256', secret).update(bodyStr).digest('hex');

    if (expected !== signature) {
      console.warn('[Webhook] invalid signature');
      return res.status(400).json({ error: 'Invalid signature' });
    }

    const event = JSON.parse(bodyStr);
    const db = getDb();

    if (event.event === 'payment.captured') {
      const paymentId = event.payload.payment.entity.id;
      const orderId   = event.payload.payment.entity.order_id;
      db.prepare(`
        UPDATE payments SET status = 'paid', razorpay_payment_id = ?, updated_at = unixepoch()
        WHERE razorpay_order_id = ? AND status != 'paid'
      `).run(paymentId, orderId);
    }

    if (event.event === 'payment.failed') {
      const orderId = event.payload.payment.entity.order_id;
      db.prepare(`
        UPDATE payments SET status = 'failed', updated_at = unixepoch()
        WHERE razorpay_order_id = ?
      `).run(orderId);
    }

    res.json({ received: true });
  } catch (err) {
    console.error('[Webhook] error:', err);
    res.status(500).json({ error: 'Webhook error' });
  }
});

module.exports = router;
