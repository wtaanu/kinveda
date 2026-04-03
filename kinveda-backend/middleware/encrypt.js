/**
 * KinVeda Encryption Module
 * AES-256-CBC encryption for all PII/sensitive data stored in the database.
 * The admin cannot read private session notes or personal messages.
 */
require('dotenv').config();
const crypto = require('crypto');

const ALGORITHM = 'aes-256-cbc';

// Derive 32-byte key and 16-byte IV from env
function getKey() {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) throw new Error('[Encrypt] ENCRYPTION_KEY not set in .env');
  return Buffer.from(raw, 'hex').slice(0, 32);
}

function getIV() {
  const raw = process.env.ENCRYPTION_IV;
  if (!raw) throw new Error('[Encrypt] ENCRYPTION_IV not set in .env');
  return Buffer.from(raw, 'hex').slice(0, 16);
}

/**
 * Encrypt a string value.
 * Returns a hex string: iv:ciphertext
 * Each call uses a fresh random IV for semantic security.
 */
function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined) return null;
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  let encrypted = cipher.update(String(plaintext), 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

/**
 * Decrypt a previously encrypted value.
 * Input format: ivHex:ciphertextHex
 */
function decrypt(ciphertext) {
  if (!ciphertext) return null;
  const [ivHex, encryptedHex] = ciphertext.split(':');
  if (!ivHex || !encryptedHex) return null;
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

/**
 * Encrypt a JSON-serializable object.
 */
function encryptJSON(obj) {
  if (!obj) return null;
  return encrypt(JSON.stringify(obj));
}

/**
 * Decrypt and parse JSON.
 */
function decryptJSON(ciphertext) {
  const decrypted = decrypt(ciphertext);
  if (!decrypted) return null;
  try { return JSON.parse(decrypted); } catch { return null; }
}

/**
 * Hash a token for storage (one-way, for refresh tokens).
 */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Generate a secure random token string.
 */
function generateToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

module.exports = { encrypt, decrypt, encryptJSON, decryptJSON, hashToken, generateToken };
