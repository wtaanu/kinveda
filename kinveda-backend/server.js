/**
 * KinVeda Backend Server
 * ─────────────────────────────────────────────────────────────────────────────
 * Starts an Express API server with:
 *  - JWT authentication (access + refresh tokens)
 *  - AES-256-CBC encryption for all PII
 *  - Role-based access: kinmember | kinmentor | admin
 *  - Admin routes mounted at obfuscated prefix (never /admin)
 *  - Rate limiting, Helmet security headers, CORS
 *  - Email notifications via Nodemailer
 * ─────────────────────────────────────────────────────────────────────────────
 * Start: node server.js
 * Dev:   npx nodemon server.js   (auto-restart on change)
 */
require('dotenv').config();

const express      = require('express');
const helmet       = require('helmet');
const cors         = require('cors');
const compression  = require('compression');
const cookieParser = require('cookie-parser');
const morgan       = require('morgan');
const rateLimit    = require('express-rate-limit');
const path         = require('path');

const { initializeSchema, getDb } = require('./config/database');
const authRoutes         = require('./routes/auth.routes');
const kinmemberRoutes    = require('./routes/kinmember.routes');
const kinmentorRoutes    = require('./routes/kinmentor.routes');
const adminRoutes        = require('./routes/admin.routes');
const chatRoutes         = require('./routes/chat.routes');
const paymentRoutes      = require('./routes/payment.routes');
const testimonialRoutes  = require('./routes/testimonial.routes');
const { sendSessionReminderEmail } = require('./config/mailer');
const { decrypt } = require('./middleware/encrypt');

// ─── Boot ─────────────────────────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3001;
const ADMIN_PREFIX = process.env.ADMIN_ROUTE_PREFIX || '/mgmt-alpha-secure';

// Initialize DB schema on start
initializeSchema();

// ─── Auto-seed Admin (first boot) ─────────────────────────────────────────────
// Runs silently on every startup; only inserts if admin doesn't yet exist.
// Eliminates the need to manually run `npm run init-db` on production hosts.
(async () => {
  try {
    const bcrypt = require('bcryptjs');
    const { encrypt } = require('./middleware/encrypt');
    const db = getDb();
    const adminEmail = process.env.ADMIN_EMAIL;
    if (!adminEmail) return; // Skip if env not configured yet
    const adminPassword = process.env.ADMIN_PASSWORD || 'KinVeda@Admin2026!';
    const passwordHash  = await bcrypt.hash(adminPassword, 12);
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(adminEmail);
    if (!existing) {
      const nameEnc = encrypt('KinVeda Admin');
      db.prepare(
        "INSERT INTO users (email, password_hash, role, name_enc, is_verified, created_at, updated_at) VALUES (?, ?, 'admin', ?, 1, unixepoch(), unixepoch())"
      ).run(adminEmail, passwordHash, nameEnc);
      console.log(`[boot] Admin user created: ${adminEmail}`);
    } else {
      // Always sync the admin password from .env on every boot so credential changes take effect immediately
      db.prepare("UPDATE users SET password_hash = ?, updated_at = unixepoch() WHERE id = ?")
        .run(passwordHash, existing.id);
    }
  } catch (e) {
    console.error('[boot] Admin seed skipped:', e.message);
  }
})();

// ─── Security ─────────────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:    ["'self'"],
      scriptSrc:     ["'self'", "'unsafe-inline'", "cdnjs.cloudflare.com", "checkout.razorpay.com", "*.razorpay.com"],
      styleSrc:      ["'self'", "'unsafe-inline'", "fonts.googleapis.com"],
      fontSrc:       ["'self'", "fonts.gstatic.com", "data:"],
      imgSrc:        ["'self'", "data:", "blob:", "*.razorpay.com"],
      connectSrc:    ["'self'", "api.razorpay.com", "*.razorpay.com", "*.jit.si", "wss://*.jit.si"],
      frameSrc:      ["'self'", "*.razorpay.com", "meet.jit.si", "*.jit.si"],
      objectSrc:     ["'none'"],
      baseUri:       ["'self'"],
      formAction:    ["'self'"],
      frameAncestors:["'none'"],
      upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null
    }
  },
  crossOriginEmbedderPolicy: false,
  hsts: {
    maxAge: 31536000,         // 1 year
    includeSubDomains: true,
    preload: true
  }
}));

// Extra DAST-required headers not covered by Helmet defaults
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// ─── CORS ─────────────────────────────────────────────────────────────────────
const allowedOrigins = [
  process.env.FRONTEND_URL || 'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:5500',      // VS Code Live Server
  'http://localhost:5500',
  // Additional origins from env (comma-separated) — set CORS_ORIGINS in production .env
  ...(process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',').map(o => o.trim()) : [])
];

app.use(cors({
  origin: (origin, cb) => {
    // Allow same-origin and local file opens
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('CORS: Origin not permitted.'));
  },
  credentials: true
}));

// ─── Compression (gzip) ───────────────────────────────────────────────────────
app.use(compression({ level: 6, threshold: 1024 }));

// ─── Parsers & Logging ────────────────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(cookieParser());
if (process.env.NODE_ENV !== 'production') app.use(morgan('dev'));

// ─── Global Rate Limiter ──────────────────────────────────────────────────────
app.use('/api/', rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000'),
  max:      parseInt(process.env.RATE_LIMIT_MAX || '100'),
  standardHeaders: true,
  legacyHeaders:   false,
  message: { success: false, message: 'Rate limit exceeded. Please slow down.' }
}));

// ─── API Routes ───────────────────────────────────────────────────────────────
app.use('/api/auth',          authRoutes);
app.use('/api/kinmember',     kinmemberRoutes);
app.use('/api/kinmentor',     kinmentorRoutes);
app.use('/api/chat',          chatRoutes);
app.use('/api/payment',       paymentRoutes);
app.use('/api/testimonials',  testimonialRoutes);

// ─── Admin Routes (OBFUSCATED) ────────────────────────────────────────────────
// ⚠️  These are NOT mounted at /admin. The path is configurable via .env.
// Share the URL only via the Admin SOP document.
app.use(`${ADMIN_PREFIX}/api`, adminRoutes);

// ─── Static Frontend ──────────────────────────────────────────────────────────
// Serve frontend HTML files from the parent Code directory.
// Cache-Control: JS/CSS/images cached 7 days; HTML never cached (always fresh).
app.use(express.static(path.join(__dirname, '..'), {
  index: 'kinveda-landing.html',
  setHeaders(res, filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (['.js', '.css', '.png', '.jpg', '.jpeg', '.svg', '.webp', '.ico', '.woff', '.woff2'].includes(ext)) {
      res.setHeader('Cache-Control', 'public, max-age=604800, immutable'); // 7 days
    } else if (ext === '.html') {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
    }
    // Additional DAST-required headers on every response
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  }
}));

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ success: true, status: 'KinVeda API is running', ts: Date.now() });
});

// ─── 404 Handler ─────────────────────────────────────────────────────────────
app.use((req, res) => {
  // For API routes, return JSON
  if (req.path.startsWith('/api') || req.path.startsWith(ADMIN_PREFIX)) {
    return res.status(404).json({ success: false, message: 'Endpoint not found.' });
  }
  // For everything else, serve landing page (SPA-style fallback)
  res.sendFile(path.join(__dirname, '..', 'kinveda-landing.html'));
});

// ─── Global Error Handler ─────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message);
  res.status(err.status || 500).json({
    success: false,
    message: process.env.NODE_ENV === 'production'
      ? 'An unexpected error occurred.'
      : err.message
  });
});

// ─── 15-Minute Session Reminder Scheduler ─────────────────────────────────────
// Runs every minute. Finds sessions that start in the next 14–16 minute window
// and sends a reminder email to BOTH the KinMember and KinMentor (once only).
// Uses a 'reminder_sent' flag on the booking_sessions table (added lazily below).
(function startReminderScheduler() {
  // Lazily add the reminder_sent column if it doesn't exist yet
  try {
    const db = getDb();
    db.exec('ALTER TABLE booking_sessions ADD COLUMN reminder_sent INTEGER DEFAULT 0');
  } catch (e) { /* column already exists — ignore */ }

  setInterval(() => {
    try {
      const db   = getDb();
      const now  = Math.floor(Date.now() / 1000);   // server time (UTC unix)
      const lo   = now + 14 * 60;   // 14 minutes from now
      const hi   = now + 16 * 60;   // 16 minutes from now

      const sessions = db.prepare(`
        SELECT bs.id, bs.scheduled_at, bs.duration_mins, bs.video_room,
               um.email AS member_email, um.name_enc AS member_name_enc,
               ut.email AS mentor_email, ut.name_enc AS mentor_name_enc
        FROM booking_sessions bs
        JOIN users um ON um.id = bs.member_id
        JOIN users ut ON ut.id = bs.mentor_id
        WHERE bs.status IN ('confirmed','pending')
          AND bs.scheduled_at BETWEEN ? AND ?
          AND (bs.reminder_sent IS NULL OR bs.reminder_sent = 0)
      `).all(lo, hi);

      for (const s of sessions) {
        // Send to KinMember
        sendSessionReminderEmail(
          s.member_email,
          decrypt(s.member_name_enc),
          decrypt(s.mentor_name_enc),
          s.scheduled_at,
          s.video_room,
          'kinmember'
        ).catch(e => console.error('[reminder] member mail:', e.message));

        // Send to KinMentor
        sendSessionReminderEmail(
          s.mentor_email,
          decrypt(s.mentor_name_enc),
          decrypt(s.member_name_enc),
          s.scheduled_at,
          s.video_room,
          'kinmentor'
        ).catch(e => console.error('[reminder] mentor mail:', e.message));

        // Mark as sent so we don't send again
        db.prepare('UPDATE booking_sessions SET reminder_sent = 1 WHERE id = ?').run(s.id);
        console.log(`[reminder] Sent 15-min alert for session #${s.id}`);
      }
    } catch (e) {
      console.error('[reminder] Scheduler error:', e.message);
    }
  }, 60 * 1000); // every 60 seconds

  console.log('[KinVeda] 15-min session reminder scheduler started.');
})();

// ─── Server-side Time Endpoint (IST) ──────────────────────────────────────────
app.get('/api/time', (req, res) => {
  const now = new Date();
  res.json({
    success:   true,
    unixTs:    Math.floor(now.getTime() / 1000),
    iso:       now.toISOString(),
    ist:       now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
    timezone:  'Asia/Kolkata'
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[KinVeda] Server running on port ${PORT} | mode: ${process.env.NODE_ENV || 'development'} | admin: ${ADMIN_PREFIX}`);
});