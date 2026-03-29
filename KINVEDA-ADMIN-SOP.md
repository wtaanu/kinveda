# KinVeda — Admin Standard Operating Procedure (SOP)
**CONFIDENTIAL — DO NOT SHARE PUBLICLY**

---

## 1. Introduction

This document is the authoritative guide for KinVeda system administrators.
**The admin dashboard URL is NOT listed on the live site and must only be shared via this document through a secure channel (Signal, encrypted email, or in person).**

---

## 2. Admin Dashboard Access

### 2.1 URL Format

The admin panel is accessible at an obfuscated URL that you configure in the `.env` file:

```
http://your-domain.com/{ADMIN_ROUTE_PREFIX}/kinveda-admin.html
```

**Default during development:**
```
http://localhost:3001/mgmt-alpha-secure/kinveda-admin.html
```

**Example production URL (change this to your own prefix):**
```
https://kinveda.in/mgmt-alpha-secure/kinveda-admin.html
```

> ⚠️ Never use `/admin`, `/dashboard`, or any predictable path. Choose a unique prefix (e.g., `/ops-hub-kv-9x`, `/secure-portal-kv-2026`). Set it in `.env` as `ADMIN_ROUTE_PREFIX`.

### 2.2 Signing In

1. Open the admin URL above in a **private/incognito browser window**
2. On the sign-in page, select **KinMember or KinMentor tab** (the sign-in form is shared — the API will detect the admin role automatically)
3. Enter your admin email and password
4. You will be redirected to the admin dashboard

> 💡 Tip: Bookmark the admin URL in a password manager, not your browser's public bookmarks.

### 2.3 Default Admin Credentials (First Run Only)

| Field | Value |
|-------|-------|
| Email | Set as `ADMIN_EMAIL` in `.env` |
| Password | Set as `ADMIN_PASSWORD` in `.env` (default: `KinVeda@Admin2026!`) |

**⚠️ Change the default password immediately after first login.**

---

## 3. First-Time Server Setup

### 3.1 Prerequisites

- Node.js 18+
- npm 9+
- A Gmail account (or SMTP server) for email notifications

### 3.2 Installation Steps

```bash
# 1. Navigate to the backend directory
cd kinveda-backend

# 2. Install dependencies
npm install

# 3. Copy environment file
cp .env.example .env

# 4. Open .env and fill in all values (see Section 4 below)
nano .env   # or use any text editor

# 5. Initialize the database and seed admin user
npm run init-db

# 6. Start the server
npm start
```

The server will start on `http://localhost:3001` by default.

### 3.3 Verifying the Setup

After `npm run init-db` you should see:
```
✅  Setup complete.
    Users:     1
    Resources: 6
```

After `npm start` you should see:
```
🌿  KinVeda server running on http://localhost:3001
    Admin route: /mgmt-alpha-secure/api
```

Test the health endpoint:
```bash
curl http://localhost:3001/api/health
# → { "status": "ok", "version": "1.0.0" }
```

---

## 4. Environment Variables Reference

Open `/kinveda-backend/.env` and set each value:

### 4.1 Server

| Variable | Example | Notes |
|----------|---------|-------|
| `PORT` | `3001` | API server port |
| `NODE_ENV` | `production` | Set to `production` in live |
| `CORS_ORIGINS` | `https://kinveda.in` | Your live domain |

### 4.2 Admin Security

| Variable | Example | Notes |
|----------|---------|-------|
| `ADMIN_ROUTE_PREFIX` | `/mgmt-alpha-secure` | **Change this in production!** |
| `ADMIN_EMAIL` | `admin@kinveda.in` | Primary admin login email |
| `ADMIN_PASSWORD` | *(see .env)* | Initial password — change immediately |
| `ADMIN_EMAIL_IDS` | `admin@kinveda.in,ops@kinveda.in` | Comma-separated list for notifications |

### 4.3 JWT Authentication

| Variable | Example | Notes |
|----------|---------|-------|
| `JWT_SECRET` | `<64-char random hex>` | **Must be strong and secret** |
| `JWT_EXPIRES_IN` | `15m` | Access token expiry |
| `JWT_REFRESH_EXPIRES_IN` | `30d` | Refresh token expiry |

Generate a strong JWT secret:
```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

### 4.4 Encryption Keys

| Variable | Example | Notes |
|----------|---------|-------|
| `ENCRYPTION_KEY` | `<64-char hex>` | AES-256-CBC key (32 bytes = 64 hex chars) |
| `ENCRYPTION_IV` | `<32-char hex>` | AES-256-CBC IV (16 bytes = 32 hex chars) |

Generate keys:
```bash
# Encryption key (32 bytes)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# IV (16 bytes)
node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"
```

> ⚠️ **Back up these keys securely.** If lost, all encrypted data (session notes, messages, PII) becomes permanently unreadable.

### 4.5 Email (SMTP)

| Variable | Example | Notes |
|----------|---------|-------|
| `SMTP_HOST` | `smtp.gmail.com` | Gmail SMTP |
| `SMTP_PORT` | `587` | TLS port |
| `SMTP_USER` | `notifications@kinveda.in` | Sender email address |
| `SMTP_PASS` | `<app-password>` | Gmail App Password (NOT your login password) |
| `EMAIL_FROM_NAME` | `KinVeda` | Display name in emails |

**Setting up Gmail App Password:**
1. Go to `myaccount.google.com/security`
2. Enable 2-Step Verification if not already enabled
3. Search "App passwords" → Create one for "Mail"
4. Copy the 16-character password into `SMTP_PASS`

### 4.6 Database

| Variable | Example | Notes |
|----------|---------|-------|
| `DB_PATH` | `./data/kinveda.db` | SQLite file path |

---

## 5. Admin Dashboard Functions

### 5.1 KPI Overview Panel

The top row shows live stats pulled from the API:
- **Total KinMembers** — registered users seeking support
- **Total KinMentors** — verified professionals on the platform
- **Sessions This Month** — completed sessions count
- **Open SOS Events** — number of unresolved crisis events (shown in red if > 0)
- **Monthly Revenue** — total session + package revenue (in Lakhs)

### 5.2 Matching KinMembers to KinMentors

When a new KinMember registers and completes their assessment:
1. Go to the **KinMember Registrations** table at the bottom of the dashboard
2. Locate the row with status **"Needs Match"**
3. Click the **"Match →"** button
4. Enter the KinMentor's User ID (visible in the KinMentor performance table)
5. Click OK — the KinMember's profile is updated and they will see their assigned KinMentor in their dashboard

**Automated matching API call:**
```
POST {ADMIN_ROUTE_PREFIX}/api/match
Body: { "memberId": "...", "mentorId": "..." }
```

### 5.3 Verifying KinMentors

New KinMentor registrations require admin verification before they appear publicly:
1. Go to the **KinMentor Performance** table
2. Locate unverified rows (status: "Unverified" or "Pending Pay")
3. After confirming RCI license and payment setup, click **"Verify"**
4. The KinMentor's profile becomes publicly visible on the platform

### 5.4 Resolving SOS Events

SOS events are triggered automatically when:
- A KinMember flags a safety concern in the assessment
- A KinMember clicks the **Quick Exit** button
- A KinMember submits the chat widget with distress keywords

Each event appears in the **Crisis & SOS Alerts** panel:
1. Review the event details (trigger type, user, timestamp)
2. Contact the KinMember and/or KinMentor as appropriate
3. Click **"Resolve"** to close the event once addressed
4. All SOS events are stored permanently in the database for audit purposes

> 🆘 **Critical SOS events** (assessment safety flags) trigger an immediate email to all addresses in `ADMIN_EMAIL_IDS`.

### 5.5 Contact Enquiries

Chat widget submissions from any page are stored as encrypted enquiries and an email is sent to all admin addresses immediately. To view past enquiries:
```
GET {ADMIN_ROUTE_PREFIX}/api/enquiries
```
(Accessible via API; admin UI enquiries panel can be added in a future sprint)

---

## 6. Data Privacy & Encryption

All personal data stored in the database is **AES-256-CBC encrypted** at the application layer before being written to SQLite. This means:

- Even if someone gains physical access to the database file, they cannot read user data
- Admin staff cannot read session notes or private chat messages
- Encryption keys live only in the `.env` file — never in the database

### Encrypted Fields

| Table | Encrypted Columns |
|-------|-------------------|
| `users` | `name_enc`, `phone_enc`, `city_enc` |
| `kinmember_profiles` | `primary_concerns_enc` |
| `kinmentor_profiles` | `bio_enc`, `approach_enc` |
| `booking_sessions` | `notes_enc` |
| `chat_messages` | `message_enc` |
| `contact_enquiries` | `name_enc`, `email_enc`, `message_enc` |
| `assessments` | `data_enc` |
| `admin_log` | `details_enc` |

### What Admins CAN See

- User names, emails, roles, registration dates
- Session counts, booking statuses, payment status
- SOS event triggers and timestamps
- Revenue totals and demographics (anonymized)

### What Admins CANNOT See

- Session notes or therapeutic content
- Private messages between KinMember and KinMentor
- Assessment responses in detail
- Chat widget messages

---

## 7. Database Backup

Back up the SQLite file regularly:

```bash
# Manual backup
cp kinveda-backend/data/kinveda.db kinveda-backup-$(date +%Y%m%d).db

# Automated daily backup (add to cron)
0 2 * * * cp /path/to/kinveda.db /backups/kinveda-$(date +\%Y\%m\%d).db
```

> ⚠️ Back up the `.env` file too — without the encryption keys, even a full database backup is unreadable.

---

## 8. Scheduled Maintenance

| Task | Frequency | Notes |
|------|-----------|-------|
| Review open SOS events | Daily | Email alerts sent automatically |
| Verify new KinMentor applications | Within 48h | Check RCI license at rci.gov.in |
| Export user report | Monthly | For compliance records |
| Rotate JWT_SECRET | Quarterly | All users will need to sign in again |
| Database backup | Daily | Automated cron recommended |
| Review audit log | Monthly | `SELECT * FROM admin_log ORDER BY created_at DESC` |

---

## 9. Audit Log

Every admin action is logged in the `admin_log` table with encrypted details:
```sql
SELECT id, admin_id, action, resource_type, resource_id, created_at
FROM admin_log
ORDER BY created_at DESC
LIMIT 50;
```

---

## 10. Emergency Procedures

### Suspected Data Breach

1. Immediately take the server offline: `pm2 stop kinveda`
2. Rotate `ENCRYPTION_KEY` and `ENCRYPTION_IV` in `.env` — note: this makes existing encrypted data unreadable until re-encrypted
3. Rotate `JWT_SECRET` — this invalidates all active sessions
4. Review `admin_log` for unauthorized actions
5. Contact your legal team and notify affected users per data protection requirements

### Lost Encryption Keys

If `ENCRYPTION_KEY` or `ENCRYPTION_IV` are lost:
- Existing encrypted data in the database is permanently unreadable
- A fresh setup (new keys, new database) will be required
- **This is why secure key backup is critical**

### Server Not Starting

```bash
# Check logs
npm start 2>&1 | head -50

# Check if port is in use
lsof -i :3001

# Check database file permissions
ls -la kinveda-backend/data/

# Re-run init
npm run init-db
```

---

## 11. Rate Limits

| Endpoint | Limit | Window |
|----------|-------|--------|
| Auth (signin/signup) | 10 requests | 15 minutes per IP |
| Chat widget | 5 messages | 15 minutes per IP |
| General API | 200 requests | 15 minutes per IP |

---

## 12. Contact & Escalation

| Role | Responsibility |
|------|----------------|
| Platform Admin | Day-to-day dashboard, SOS response, KinMentor verification |
| Technical Lead | Server maintenance, backups, security patches |
| Clinical Supervisor | SOS event review, KinMentor oversight |

---

*Document version: 1.0 — March 2026*
*This document is confidential and intended only for authorized KinVeda administrators.*
