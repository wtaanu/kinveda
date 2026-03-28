/**
 * KinVeda Database Configuration
 * SQLite via better-sqlite3 — works on Node 18/20/22, Hostinger compatible.
 * All PII fields AES-256-CBC encrypted at app layer.
 */
require('dotenv').config();
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || './data/kinveda.db';

let db;

function getDb() {
  if (!db) {
    const dir = path.dirname(path.resolve(DB_PATH));
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    db = new Database(path.resolve(DB_PATH));
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
  }
  return db;
}

function initializeSchema() {
  const database = getDb();

  database.exec(`
    -- ============================================================
    -- USERS (base identity — PII encrypted)
    -- signup_status: 'pre_registered' (from chat/widget only) | 'registered' (signed up)
    -- ============================================================
    CREATE TABLE IF NOT EXISTS users (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      email               TEXT    UNIQUE NOT NULL,
      password_hash       TEXT    DEFAULT '',
      role                TEXT    NOT NULL DEFAULT 'kinmember'
                            CHECK(role IN ('kinmember','kinmentor','admin')),
      name_enc            TEXT,
      phone_enc           TEXT,
      city_enc            TEXT,
      is_verified         INTEGER DEFAULT 0,
      is_active           INTEGER DEFAULT 1,
      signup_status       TEXT    DEFAULT 'registered'
                            CHECK(signup_status IN ('pre_registered','registered','active')),
      verification_token  TEXT,
      reset_token         TEXT,
      reset_token_expiry  INTEGER,
      created_at          INTEGER DEFAULT (unixepoch()),
      updated_at          INTEGER DEFAULT (unixepoch()),
      last_login          INTEGER
    );

    -- ============================================================
    -- KINMEMBER PROFILES
    -- ============================================================
    CREATE TABLE IF NOT EXISTS kinmember_profiles (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      family_structure      TEXT,
      child_status          TEXT,
      primary_concerns_enc  TEXT,
      household_enc         TEXT,
      wellness_score        REAL    DEFAULT 0,
      assigned_mentor_id    INTEGER REFERENCES users(id),
      assessment_completed  INTEGER DEFAULT 0,
      package_active        INTEGER DEFAULT 0,
      package_renewal_date  INTEGER,
      created_at            INTEGER DEFAULT (unixepoch()),
      updated_at            INTEGER DEFAULT (unixepoch())
    );

    -- ============================================================
    -- KINMENTOR PROFILES
    -- ============================================================
    CREATE TABLE IF NOT EXISTS kinmentor_profiles (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      rci_license         TEXT,
      qualification_enc   TEXT,
      bio_enc             TEXT,
      approach_enc        TEXT,
      specializations     TEXT    DEFAULT '[]',
      languages           TEXT    DEFAULT 'Hindi,English',
      experience_years    INTEGER DEFAULT 0,
      fee_30min           REAL    DEFAULT 0,
      fee_60min           REAL    DEFAULT 0,
      fee_monthly         REAL    DEFAULT 0,
      is_rci_verified     INTEGER DEFAULT 0,
      is_payment_verified INTEGER DEFAULT 0,
      is_profile_public   INTEGER DEFAULT 0,
      avg_rating          REAL    DEFAULT 0,
      total_reviews       INTEGER DEFAULT 0,
      total_sessions      INTEGER DEFAULT 0,
      total_earned        REAL    DEFAULT 0,
      total_paid_out      REAL    DEFAULT 0,
      created_at          INTEGER DEFAULT (unixepoch()),
      updated_at          INTEGER DEFAULT (unixepoch())
    );

    -- ============================================================
    -- MENTOR AVAILABILITY SLOTS (detailed week-based)
    -- day_of_week: 0=Monday … 6=Sunday
    -- ============================================================
    CREATE TABLE IF NOT EXISTS mentor_availability (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      mentor_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day_of_week     INTEGER NOT NULL CHECK(day_of_week BETWEEN 0 AND 6),
      start_time      TEXT    NOT NULL,
      end_time        TEXT    NOT NULL,
      label           TEXT,
      is_active       INTEGER DEFAULT 1,
      effective_from  INTEGER,
      effective_until INTEGER,
      created_at      INTEGER DEFAULT (unixepoch())
    );

    -- ============================================================
    -- BOOKING SESSIONS
    -- ============================================================
    CREATE TABLE IF NOT EXISTS booking_sessions (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id       INTEGER NOT NULL REFERENCES users(id),
      mentor_id       INTEGER NOT NULL REFERENCES users(id),
      scheduled_at    INTEGER NOT NULL,
      duration_mins   INTEGER DEFAULT 60,
      status          TEXT    DEFAULT 'pending'
                        CHECK(status IN ('pending','confirmed','in_progress','completed','cancelled')),
      payment_status  TEXT    DEFAULT 'unpaid'
                        CHECK(payment_status IN ('unpaid','paid','refunded','waived')),
      payment_waived  INTEGER DEFAULT 0,
      amount          REAL    DEFAULT 0,
      notes_enc       TEXT,
      feedback_given  INTEGER DEFAULT 0,
      video_room      TEXT,
      calendar_uid    TEXT,
      created_at      INTEGER DEFAULT (unixepoch()),
      updated_at      INTEGER DEFAULT (unixepoch())
    );

    -- ============================================================
    -- VIDEO SESSIONS (Jitsi room tracking + recordings)
    -- ============================================================
    CREATE TABLE IF NOT EXISTS video_sessions (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id      INTEGER NOT NULL REFERENCES booking_sessions(id) ON DELETE CASCADE,
      room_name       TEXT    NOT NULL UNIQUE,
      started_at      INTEGER,
      ended_at        INTEGER,
      duration_mins   INTEGER,
      recording_url   TEXT,
      recording_uploaded_by INTEGER REFERENCES users(id),
      created_at      INTEGER DEFAULT (unixepoch())
    );

    -- ============================================================
    -- CHAT MESSAGES (encrypted, private member↔mentor)
    -- ============================================================
    CREATE TABLE IF NOT EXISTS chat_messages (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id     INTEGER NOT NULL REFERENCES users(id),
      receiver_id   INTEGER NOT NULL REFERENCES users(id),
      message_enc   TEXT    NOT NULL,
      is_read       INTEGER DEFAULT 0,
      created_at    INTEGER DEFAULT (unixepoch())
    );

    -- ============================================================
    -- CONTACT / CHAT-WIDGET ENQUIRIES
    -- ============================================================
    CREATE TABLE IF NOT EXISTS contact_enquiries (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name_enc      TEXT,
      email_enc     TEXT,
      message_enc   TEXT NOT NULL,
      source_page   TEXT,
      user_id       INTEGER REFERENCES users(id),
      email_sent    INTEGER DEFAULT 0,
      created_at    INTEGER DEFAULT (unixepoch())
    );

    -- ============================================================
    -- RAZORPAY PAYMENTS
    -- ============================================================
    CREATE TABLE IF NOT EXISTS payments (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id               INTEGER NOT NULL REFERENCES users(id),
      session_id            INTEGER REFERENCES booking_sessions(id),
      subscription_id       INTEGER REFERENCES subscriptions(id),
      razorpay_order_id     TEXT    UNIQUE,
      razorpay_payment_id   TEXT,
      razorpay_signature    TEXT,
      amount_paise          INTEGER NOT NULL,
      currency              TEXT    DEFAULT 'INR',
      status                TEXT    DEFAULT 'created'
                              CHECK(status IN ('created','paid','failed','refunded')),
      payment_type          TEXT    CHECK(payment_type IN ('session','subscription')),
      notes_enc             TEXT,
      created_at            INTEGER DEFAULT (unixepoch()),
      updated_at            INTEGER DEFAULT (unixepoch())
    );

    -- ============================================================
    -- SUBSCRIPTIONS (monthly packages)
    -- ============================================================
    CREATE TABLE IF NOT EXISTS subscriptions (
      id                          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id                     INTEGER NOT NULL REFERENCES users(id),
      mentor_id                   INTEGER REFERENCES users(id),
      razorpay_subscription_id    TEXT    UNIQUE,
      plan_name                   TEXT    DEFAULT 'Monthly Care Package',
      amount_inr                  REAL    NOT NULL,
      status                      TEXT    DEFAULT 'active'
                                    CHECK(status IN ('created','active','paused','cancelled','completed','expired')),
      sessions_included           INTEGER DEFAULT 8,
      sessions_used               INTEGER DEFAULT 0,
      billing_cycle_start         INTEGER,
      billing_cycle_end           INTEGER,
      cancelled_at                INTEGER,
      cancel_reason               TEXT,
      created_at                  INTEGER DEFAULT (unixepoch()),
      updated_at                  INTEGER DEFAULT (unixepoch())
    );

    -- ============================================================
    -- PAYOUTS (admin → mentor transfers)
    -- ============================================================
    CREATE TABLE IF NOT EXISTS payouts (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id          INTEGER NOT NULL REFERENCES users(id),
      mentor_id         INTEGER NOT NULL REFERENCES users(id),
      session_id        INTEGER REFERENCES booking_sessions(id),
      gross_amount      REAL NOT NULL,
      platform_cut_pct  REAL DEFAULT 0,
      payout_amount     REAL NOT NULL,
      status            TEXT DEFAULT 'pending'
                          CHECK(status IN ('pending','processed','failed')),
      transfer_ref      TEXT,
      notes             TEXT,
      processed_at      INTEGER,
      created_at        INTEGER DEFAULT (unixepoch())
    );

    -- ============================================================
    -- ASSESSMENTS
    -- ============================================================
    CREATE TABLE IF NOT EXISTS assessments (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id         INTEGER NOT NULL REFERENCES users(id),
      data_enc        TEXT    NOT NULL,
      score           INTEGER DEFAULT 0,
      sos_triggered   INTEGER DEFAULT 0,
      created_at      INTEGER DEFAULT (unixepoch())
    );

    -- ============================================================
    -- SOS EVENTS
    -- ============================================================
    CREATE TABLE IF NOT EXISTS sos_events (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER REFERENCES users(id),
      trigger_type  TEXT,
      status        TEXT DEFAULT 'active'
                      CHECK(status IN ('active','resolved','escalated')),
      resolved_by   INTEGER REFERENCES users(id),
      notes_enc     TEXT,
      created_at    INTEGER DEFAULT (unixepoch()),
      resolved_at   INTEGER
    );

    -- ============================================================
    -- RESOURCES / LIBRARY
    -- ============================================================
    CREATE TABLE IF NOT EXISTS resources (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      title               TEXT NOT NULL,
      description         TEXT,
      category            TEXT,
      file_url            TEXT,
      target_family_type  TEXT,
      created_by          INTEGER REFERENCES users(id),
      is_active           INTEGER DEFAULT 1,
      created_at          INTEGER DEFAULT (unixepoch())
    );

    -- ============================================================
    -- FEEDBACK / REVIEWS
    -- ============================================================
    CREATE TABLE IF NOT EXISTS feedback (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id    INTEGER NOT NULL REFERENCES booking_sessions(id),
      member_id     INTEGER NOT NULL REFERENCES users(id),
      mentor_id     INTEGER NOT NULL REFERENCES users(id),
      rating        INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
      comment_enc   TEXT,
      is_public     INTEGER DEFAULT 0,
      created_at    INTEGER DEFAULT (unixepoch())
    );

    -- ============================================================
    -- TESTIMONIALS (public user stories — landing page)
    -- Only shown if rating >= 4 and is_approved = 1
    -- ============================================================
    CREATE TABLE IF NOT EXISTS testimonials (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id         INTEGER REFERENCES users(id),
      rating          INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
      story_enc       TEXT    NOT NULL,
      author_display  TEXT,
      concern_tag     TEXT,
      is_approved     INTEGER DEFAULT 0,
      is_public       INTEGER DEFAULT 0,
      approved_by     INTEGER REFERENCES users(id),
      created_at      INTEGER DEFAULT (unixepoch())
    );

    -- ============================================================
    -- PLATFORM CONTENT (admin-created blogs, announcements)
    -- ============================================================
    CREATE TABLE IF NOT EXISTS platform_content (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id      INTEGER NOT NULL REFERENCES users(id),
      type          TEXT    NOT NULL
                      CHECK(type IN ('blog','announcement','resource_page')),
      title         TEXT    NOT NULL,
      slug          TEXT    UNIQUE,
      content       TEXT    NOT NULL,
      excerpt       TEXT,
      category      TEXT,
      is_published  INTEGER DEFAULT 0,
      published_at  INTEGER,
      created_at    INTEGER DEFAULT (unixepoch()),
      updated_at    INTEGER DEFAULT (unixepoch())
    );

    -- ============================================================
    -- HOMEWORK
    -- ============================================================
    CREATE TABLE IF NOT EXISTS homework (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id     INTEGER NOT NULL REFERENCES users(id),
      mentor_id     INTEGER NOT NULL REFERENCES users(id),
      session_id    INTEGER REFERENCES booking_sessions(id),
      task_enc      TEXT    NOT NULL,
      due_date      INTEGER,
      is_completed  INTEGER DEFAULT 0,
      created_at    INTEGER DEFAULT (unixepoch())
    );

    -- ============================================================
    -- BLOG POSTS (by KinMentor)
    -- ============================================================
    CREATE TABLE IF NOT EXISTS blog_posts (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      mentor_id     INTEGER NOT NULL REFERENCES users(id),
      title         TEXT    NOT NULL,
      slug          TEXT    UNIQUE,
      category      TEXT,
      content       TEXT    NOT NULL,
      excerpt       TEXT,
      is_published  INTEGER DEFAULT 0,
      published_at  INTEGER,
      created_at    INTEGER DEFAULT (unixepoch()),
      updated_at    INTEGER DEFAULT (unixepoch())
    );

    -- ============================================================
    -- ADMIN AUDIT LOG
    -- ============================================================
    CREATE TABLE IF NOT EXISTS admin_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id      INTEGER NOT NULL REFERENCES users(id),
      action        TEXT    NOT NULL,
      target_type   TEXT,
      target_id     INTEGER,
      details_enc   TEXT,
      ip_address    TEXT,
      created_at    INTEGER DEFAULT (unixepoch())
    );

    -- ============================================================
    -- REFRESH TOKENS (JWT rotation)
    -- ============================================================
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash    TEXT    UNIQUE NOT NULL,
      expires_at    INTEGER NOT NULL,
      revoked       INTEGER DEFAULT 0,
      created_at    INTEGER DEFAULT (unixepoch())
    );

    -- ============================================================
    -- INDEXES
    -- ============================================================
    CREATE INDEX IF NOT EXISTS idx_users_email           ON users(email);
    CREATE INDEX IF NOT EXISTS idx_users_status          ON users(signup_status);
    CREATE INDEX IF NOT EXISTS idx_sessions_member       ON booking_sessions(member_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_mentor       ON booking_sessions(mentor_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_status       ON booking_sessions(status);
    CREATE INDEX IF NOT EXISTS idx_chat_pair             ON chat_messages(sender_id, receiver_id);
    CREATE INDEX IF NOT EXISTS idx_chat_receiver         ON chat_messages(receiver_id, is_read);
    CREATE INDEX IF NOT EXISTS idx_payments_user         ON payments(user_id);
    CREATE INDEX IF NOT EXISTS idx_payments_order        ON payments(razorpay_order_id);
    CREATE INDEX IF NOT EXISTS idx_subscriptions_user    ON subscriptions(user_id);
    CREATE INDEX IF NOT EXISTS idx_availability_mentor   ON mentor_availability(mentor_id, day_of_week);
    CREATE INDEX IF NOT EXISTS idx_testimonials_public   ON testimonials(is_public, is_approved, rating);
  `);

  console.log('✓ Schema initialized (better-sqlite3)');
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = { getDb, initializeSchema, closeDb };