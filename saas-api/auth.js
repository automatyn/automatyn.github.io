const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const https = require('https');

const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const VERIFY_TOKENS_FILE = path.join(DATA_DIR, 'verify-tokens.json');
const RESET_TOKENS_FILE = path.join(DATA_DIR, 'reset-tokens.json');

const BCRYPT_COST = 12;
const DUMMY_HASH = '$2b$12$dummyhashfortimingattackpreventionxxxxxxxxxxxxxxxxxxxxxx';

const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const RESET_TOKEN_TTL_MS = 1 * 60 * 60 * 1000; // 1 hour
const UNVERIFIED_OVERWRITE_AFTER_MS = 24 * 60 * 60 * 1000; // 24 hours

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ============ File I/O helpers ============
function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}
function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// ============ User store ============
function loadUsers() { return readJson(USERS_FILE, {}); }
function saveUsers(users) { writeJson(USERS_FILE, users); }
function getUser(email) {
  const users = loadUsers();
  return users[email.toLowerCase()] || null;
}
function setUser(email, user) {
  const users = loadUsers();
  users[email.toLowerCase()] = user;
  saveUsers(users);
}
function deleteUser(email) {
  const users = loadUsers();
  delete users[email.toLowerCase()];
  saveUsers(users);
}

// ============ Token stores ============
function loadVerifyTokens() { return readJson(VERIFY_TOKENS_FILE, {}); }
function saveVerifyTokens(t) { writeJson(VERIFY_TOKENS_FILE, t); }
function loadResetTokens() { return readJson(RESET_TOKENS_FILE, {}); }
function saveResetTokens(t) { writeJson(RESET_TOKENS_FILE, t); }

// ============ Password breach check (HIBP k-anonymity) ============
function sha1Upper(str) {
  return crypto.createHash('sha1').update(str).digest('hex').toUpperCase();
}
function checkHibp(password) {
  return new Promise((resolve) => {
    const hash = sha1Upper(password);
    const prefix = hash.slice(0, 5);
    const suffix = hash.slice(5);
    const req = https.get(
      `https://api.pwnedpasswords.com/range/${prefix}`,
      { headers: { 'User-Agent': 'Automatyn-SaaS' }, timeout: 3000 },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          const lines = body.split('\n');
          for (const line of lines) {
            const [hashSuffix] = line.split(':');
            if (hashSuffix && hashSuffix.trim() === suffix) {
              return resolve(true); // breached
            }
          }
          resolve(false); // not breached
        });
      }
    );
    req.on('error', () => resolve(false)); // fail-open
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// ============ Validation ============
function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 320;
}
function validPassword(password) {
  if (typeof password !== 'string') return { ok: false, error: 'Password is required' };
  if (password.length < 8) return { ok: false, error: 'Password must be at least 8 characters' };
  if (password.length > 128) return { ok: false, error: 'Password is too long (max 128 characters)' };
  return { ok: true };
}

// ============ Token generation ============
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ============ Brevo email ============
const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
if (!BREVO_API_KEY) {
  console.warn('[auth] BREVO_API_KEY not set — verification/reset emails will fail');
}

function sendEmail({ to, subject, htmlContent }) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      sender: { name: 'Automatyn', email: 'noreply@automatyn.co' },
      replyTo: { email: 'support@automatyn.co' },
      to: [{ email: to }],
      subject,
      htmlContent,
    });
    const req = https.request(
      'https://api.brevo.com/v3/smtp/email',
      {
        method: 'POST',
        headers: {
          'accept': 'application/json',
          'api-key': BREVO_API_KEY,
          'content-type': 'application/json',
        },
        timeout: 10000,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
          else reject(new Error(`Brevo error ${res.statusCode}: ${data}`));
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Brevo timeout')); });
    req.write(body);
    req.end();
  });
}

function verificationEmailHtml(verifyUrl) {
  return `<!DOCTYPE html>
<html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #030303; color: #f5f5f5; padding: 40px 20px; margin: 0;">
  <div style="max-width: 520px; margin: 0 auto; background: #0a0a0a; border: 1px solid rgba(255,255,255,0.08); border-radius: 16px; padding: 40px; box-shadow: 0 20px 60px rgba(0,0,0,0.5);">
    <div style="font-size: 28px; font-weight: 800; letter-spacing: -0.04em; margin-bottom: 24px;">Automatyn<span style="color: #22d3ee;">.</span></div>
    <h1 style="font-size: 22px; font-weight: 700; margin: 0 0 12px; color: #fff;">Verify your email</h1>
    <p style="color: #a1a1aa; line-height: 1.6; margin: 0 0 28px; font-size: 15px;">Confirm your email to activate your Automatyn account. This link expires in 24 hours.</p>
    <a href="${verifyUrl}" style="display: inline-block; background: linear-gradient(180deg, #10b981 0%, #059669 100%); color: #fff; padding: 14px 32px; border-radius: 9999px; text-decoration: none; font-weight: 700; font-size: 15px;">Verify email</a>
    <p style="color: #71717a; font-size: 13px; margin: 28px 0 0; line-height: 1.6;">Or copy this link:<br><span style="color: #a1a1aa; word-break: break-all;">${verifyUrl}</span></p>
    <hr style="border: none; border-top: 1px solid rgba(255,255,255,0.08); margin: 32px 0;">
    <p style="color: #52525b; font-size: 12px; margin: 0;">Didn't sign up? Ignore this email.</p>
  </div>
</body></html>`;
}

function resetEmailHtml(resetUrl) {
  return `<!DOCTYPE html>
<html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #030303; color: #f5f5f5; padding: 40px 20px; margin: 0;">
  <div style="max-width: 520px; margin: 0 auto; background: #0a0a0a; border: 1px solid rgba(255,255,255,0.08); border-radius: 16px; padding: 40px; box-shadow: 0 20px 60px rgba(0,0,0,0.5);">
    <div style="font-size: 28px; font-weight: 800; letter-spacing: -0.04em; margin-bottom: 24px;">Automatyn<span style="color: #22d3ee;">.</span></div>
    <h1 style="font-size: 22px; font-weight: 700; margin: 0 0 12px; color: #fff;">Reset your password</h1>
    <p style="color: #a1a1aa; line-height: 1.6; margin: 0 0 28px; font-size: 15px;">Someone requested a password reset for your account. This link expires in 1 hour.</p>
    <a href="${resetUrl}" style="display: inline-block; background: linear-gradient(180deg, #22d3ee 0%, #0891b2 100%); color: #030303; padding: 14px 32px; border-radius: 9999px; text-decoration: none; font-weight: 700; font-size: 15px;">Reset password</a>
    <p style="color: #71717a; font-size: 13px; margin: 28px 0 0; line-height: 1.6;">Or copy this link:<br><span style="color: #a1a1aa; word-break: break-all;">${resetUrl}</span></p>
    <hr style="border: none; border-top: 1px solid rgba(255,255,255,0.08); margin: 32px 0;">
    <p style="color: #52525b; font-size: 12px; margin: 0;">Didn't request this? Ignore the email; your password is unchanged.</p>
  </div>
</body></html>`;
}

// ============ Rate limiting ============
const rateBuckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const entries = (rateBuckets.get(key) || []).filter((t) => now - t < windowMs);
  if (entries.length >= max) return false;
  entries.push(now);
  rateBuckets.set(key, entries);
  return true;
}

// ============ Password hashing ============
async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_COST);
}
async function verifyPassword(password, hash) {
  try {
    return await bcrypt.compare(password, hash);
  } catch {
    return false;
  }
}

module.exports = {
  loadUsers, saveUsers, getUser, setUser, deleteUser,
  loadVerifyTokens, saveVerifyTokens,
  loadResetTokens, saveResetTokens,
  checkHibp, validEmail, validPassword,
  generateToken, sendEmail,
  verificationEmailHtml, resetEmailHtml,
  rateLimit, hashPassword, verifyPassword,
  DUMMY_HASH,
  VERIFY_TOKEN_TTL_MS, RESET_TOKEN_TTL_MS, UNVERIFIED_OVERWRITE_AFTER_MS,
};
