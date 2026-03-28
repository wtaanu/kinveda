/**
 * KinVeda – Database Initialisation Script
 * Run: npm run init-db
 *
 * Creates the database file, applies the schema, and seeds an admin user.
 * Safe to re-run: existing tables are NOT dropped (CREATE TABLE IF NOT EXISTS).
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { initializeSchema, getDb } = require('./database');
const { encrypt } = require('../middleware/encrypt');

// ─── Validate env ────────────────────────────────────────────────────────────
const required = ['JWT_SECRET', 'ENCRYPTION_KEY', 'ENCRYPTION_IV', 'ADMIN_EMAIL'];
const missing = required.filter(k => !process.env[k]);
if (missing.length) {
  console.error('❌  Missing required env vars:', missing.join(', '));
  console.error('    Copy .env.example → .env and fill in values first.');
  process.exit(1);
}

// ─── Run ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n🌿  KinVeda Database Setup\n');

  // 1. Init schema
  console.log('📦  Applying schema…');
  initializeSchema();
  console.log('    ✓ Schema applied');

  const db = getDb();

  // 2. Seed admin user
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD || 'KinVeda@Admin2026!';
  const existingAdmin = db.prepare('SELECT id FROM users WHERE email = ?').get(adminEmail);

  if (existingAdmin) {
    console.log(`\n👤  Admin user already exists: ${adminEmail}`);
  } else {
    const passwordHash = await bcrypt.hash(adminPassword, 12);
    const adminId = uuidv4();
    const nameEnc = encrypt('KinVeda Admin');

    db.prepare(`
      INSERT INTO users (id, email, password_hash, role, name_enc, is_verified, created_at, updated_at)
      VALUES (?, ?, ?, 'admin', ?, 1, unixepoch(), unixepoch())
    `).run(adminId, adminEmail, passwordHash, nameEnc);

    console.log(`\n👤  Admin user created:`);
    console.log(`    Email:    ${adminEmail}`);
    console.log(`    Password: ${adminPassword}`);
    console.log(`\n    ⚠️  CHANGE THE DEFAULT PASSWORD immediately after first login.`);
  }

  // 3. Seed sample resources (if empty)
  const resourceCount = db.prepare('SELECT COUNT(*) as cnt FROM resources').get().cnt;
  if (resourceCount === 0) {
    console.log('\n📚  Seeding default resources…');
    const resources = [
      { title: 'Only Child Survival Guide', description: 'Managing parental pressure and building lateral support networks', category: 'Family Structure', file_url: '/resources/only-child-guide.pdf' },
      { title: 'Boundary Setting Workbook', description: 'For nuclear family stress — practical exercises and scripts', category: 'Boundaries', file_url: '/resources/boundary-workbook.pdf' },
      { title: 'Personal Safety Plan Template', description: 'Customizable SOS document with emergency contacts and coping steps', category: 'Safety', file_url: '/resources/safety-plan.pdf' },
      { title: 'Generation Gap Communication Guide', description: 'CBT-based framework for navigating intergenerational conflict', category: 'Communication', file_url: '/resources/generation-gap-guide.pdf' },
      { title: 'Substance Use Support Handbook', description: 'For families affected by alcohol or substance dependency', category: 'Substance Use', file_url: '/resources/substance-support.pdf' },
      { title: 'Domestic Stress First Aid', description: 'Immediate coping strategies and professional escalation paths', category: 'Safety', file_url: '/resources/domestic-stress.pdf' },
    ];

    const insertResource = db.prepare(`
      INSERT INTO resources (id, title, description, category, file_url, created_at)
      VALUES (?, ?, ?, ?, ?, unixepoch())
    `);
    resources.forEach(r => insertResource.run(uuidv4(), r.title, r.description, r.category, r.file_url));
    console.log(`    ✓ ${resources.length} resources seeded`);
  }

  // 4. Print summary
  const userCount = db.prepare('SELECT COUNT(*) as cnt FROM users').get().cnt;
  const resourceTotal = db.prepare('SELECT COUNT(*) as cnt FROM resources').get().cnt;

  console.log('\n📊  Database Summary:');
  console.log(`    Users:     ${userCount}`);
  console.log(`    Resources: ${resourceTotal}`);

  const dbPath = process.env.DB_PATH || path.join(__dirname, '../data/kinveda.db');
  console.log(`\n    Database:  ${dbPath}`);
  console.log('\n✅  Setup complete. Run `npm start` to launch the server.\n');
}

main().catch(err => {
  console.error('\n❌  Setup failed:', err.message);
  process.exit(1);
});
