/**
 * KinVeda — Account Setup Script
 * Run this ONCE on your Hostinger server to create the admin account and any test accounts.
 *
 * Usage (in Hostinger Node.js terminal / SSH):
 *   node create-accounts.js
 *
 * This script is safe to re-run — it skips accounts that already exist.
 */

require('dotenv').config();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

// Use the shared database module — this creates the data/ dir and schema if needed
const { getDb, initializeSchema } = require('./config/database');

const ENC_KEY = process.env.ENCRYPTION_KEY;
const ENC_IV  = process.env.ENCRYPTION_IV;

if (!ENC_KEY || !ENC_IV) {
  console.error('❌  ENCRYPTION_KEY / ENCRYPTION_IV not set. Check your .env file.');
  process.exit(1);
}

function encrypt(plaintext) {
  if (!plaintext) return null;
  const iv     = crypto.randomBytes(16);
  const key    = Buffer.from(ENC_KEY, 'hex').slice(0, 32);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let enc = cipher.update(String(plaintext), 'utf8', 'hex');
  enc += cipher.final('hex');
  return iv.toString('hex') + ':' + enc;
}

const ACCOUNTS = [
  { email: 'wtaanu@gmail.com',           password: 'Ak2109@kk', name: 'Anuragini Pathak',  role: 'admin',     label: 'Admin' },
  { email: 'test2@gmail.com',            password: 'Ak2109@kk', name: 'Test Mentor',        role: 'kinmentor', label: 'KinMentor test' },
  { email: 'test3m@gmail.com',           password: 'Ak2109@kk', name: 'Test Member',        role: 'kinmember', label: 'KinMember test' }
];

async function main() {
  console.log('\n🌿 KinVeda Account Setup');
  console.log(`   DB: ${process.env.DB_PATH || './data/kinveda.db'}\n`);

  // Init schema (creates tables + data/ dir if they don't exist)
  initializeSchema();

  const db = getDb();

  for (const acct of ACCOUNTS) {
    console.log(`→ Creating ${acct.label}: ${acct.email}`);

    const existing = db.prepare('SELECT id, role FROM users WHERE email = ?').get(acct.email);
    if (existing) {
      console.log(`  ⚠️  Already exists (id=${existing.id}, role=${existing.role}) — skipping.\n`);
      continue;
    }

    const hash   = await bcrypt.hash(acct.password, 12);
    const result = db.prepare(`
      INSERT INTO users (email, password_hash, role, name_enc, signup_status, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'registered', 1, unixepoch(), unixepoch())
    `).run(acct.email, hash, acct.role, encrypt(acct.name));

    const userId = result.lastInsertRowid;
    console.log(`  ✅  User created (id=${userId})`);

    if (acct.role === 'kinmember') {
      db.prepare('INSERT OR IGNORE INTO kinmember_profiles (user_id) VALUES (?)').run(userId);
      console.log(`  ✅  KinMember profile created\n`);
    } else if (acct.role === 'kinmentor') {
      db.prepare('INSERT OR IGNORE INTO kinmentor_profiles (user_id, is_profile_public) VALUES (?, 1)').run(userId);
      db.prepare(`
        UPDATE kinmentor_profiles SET
          qualification_enc = ?, bio_enc = ?,
          specializations = ?, languages = ?,
          experience_years = 3, fee_30min = 500, fee_60min = 900, fee_monthly = 6000,
          is_rci_verified = 1, avg_rating = 4.5
        WHERE user_id = ?
      `).run(
        encrypt('M.Sc. Counselling Psychology'),
        encrypt('Experienced family wellness counsellor specialising in nuclear family dynamics.'),
        JSON.stringify(['Family Therapy', 'Anxiety', 'Child Development', 'Couples Counselling']),
        'Hindi, English',
        userId
      );
      console.log(`  ✅  KinMentor profile created\n`);
    } else {
      console.log('');
    }
  }

  console.log('─────────────────────────────────────────');
  console.log('✅  Done! Accounts in DB:');
  const users = db.prepare('SELECT id, email, role, is_active FROM users ORDER BY id').all();
  users.forEach(u => console.log(`   id=${u.id}  ${u.role.padEnd(12)}  ${u.email}  active=${u.is_active}`));
  console.log('\n📋  Login credentials:');
  ACCOUNTS.forEach(a => console.log(`   ${a.role.padEnd(12)}  ${a.email}  /  ${a.password}`));
  console.log('\n🔐  Admin portal URL:');
  console.log('   https://kinveda.autogreet.in/kinveda-signin.html?role=admin\n');
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
