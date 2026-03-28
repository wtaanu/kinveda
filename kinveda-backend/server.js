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

const express     = require('express');
const helmet      = require('helmet');
const cors        = require('cors');
const cookieParser = require('cookie-parser');
const morgan      = require('morgan');
const rateLimit   = require('express-rate-limit');
const path        = require('path');

const { initializeSchema, getDb } = require('./config/database');
const authRoutes         = require('./routes/auth.routes');
const kinmemberRoutes    = require('./routes/kinmember.routes');
const kinmentorRoutes    = require('./routes/kinmentor.routes');
const adminRoutes        = require('./routes/admin.routes');
const chatRoutes         = require('./routes/chat.routes');
const paymentRoutes      = require('./routes/payment.routes');
const testimonialRoutes  = require('./routes/testimonial.routes');

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
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(adminEmail);
    if (!existing) {
      const adminPassword = process.env.ADMIN_PASSWORD || 'KinVeda@Admin2026!';
      const passwordHash = await bcrypt.hash(adminPassword, 12);
      const nameEnc = encrypt('KinVeda Admin');
      db.prepare(
        'INSERT INTO users (email, password_hash, role, name_enc, is_verified, created_at, updated_at) VALUES (?, ?, \'admin\', ?, 1, unixepoch(), unixepoch())'
      ).run(adminEmail, passwordHash, nameEnc);
      console.log(`[boot] Admin user created: ${adminEmail}`);
    }
  } catch (e) {
    console.error('[boot] Admin seed skipped:', e.message);
  }
})();

// ─── Security ─────────────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'", "cdnjs.cloudflare.com", "checkout.razorpay.com", "*.razorpay.com"],
      styleSrc:   ["'self'", "'unsafe-inline'"],
      imgSrc:     ["'self'", "data:", "*.razorpay.com"],
      connectSrc: ["'self'", "api.razorpay.com", "*.razorpay.com"],
      frameSrc:   ["'self'", "*.razorpay.com", "meet.jit.si", "*.jit.si"],
      objectSrc:  ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));

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
// Serve frontend HTML files from the parent Code directory
app.use(express.static(path.join(__dirname, '..'), {
  index: 'kinveda-landing.html'
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

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[KinVeda] Server running on port ${PORT} | mode: ${process.env.NODE_ENV || 'development'} | admin: ${ADMIN_PREFIX}`);
});