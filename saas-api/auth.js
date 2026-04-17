const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const https = require('https');

const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const VERIFY_TOKENS_FILE = path.join(DATA_DIR, 'verify-tokens.json');
const RESET_TOKENS_FILE = path.join(DATA_DIR, 'reset-tokens.json');
const MAGIC_LINK_TOKENS_FILE = path.join(DATA_DIR, 'magic-link-tokens.json');

const BCRYPT_COST = 12;
const DUMMY_HASH = '$2b$12$dummyhashfortimingattackpreventionxxxxxxxxxxxxxxxxxxxxxx';

const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const RESET_TOKEN_TTL_MS = 1 * 60 * 60 * 1000; // 1 hour
const MAGIC_LINK_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes (short-lived, login-specific)
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
function loadMagicLinkTokens() { return readJson(MAGIC_LINK_TOKENS_FILE, {}); }
function saveMagicLinkTokens(t) { writeJson(MAGIC_LINK_TOKENS_FILE, t); }

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

// ============ Brevo contact management ============
const BREVO_LIST_SIGNUPS = 5;
const BREVO_LIST_GUIDE = 6;
const BREVO_LIST_DEMO = 7;

function addContactToList(email, listId, attributes = {}) {
  if (!BREVO_API_KEY) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      email,
      listIds: [listId],
      attributes,
      updateEnabled: true,
    });
    const req = https.request(
      'https://api.brevo.com/v3/contacts',
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
          else reject(new Error(`Brevo contact error ${res.statusCode}: ${data}`));
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Brevo timeout')); });
    req.write(body);
    req.end();
  });
}

// ============ Email template shared components ============
const EMAIL_FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
const EMAIL_BODY = `font-family: ${EMAIL_FONT}; background: #030303; color: #f5f5f5; padding: 40px 20px; margin: 0;`;
const EMAIL_CARD = 'max-width: 520px; margin: 0 auto; background: #0a0a0a; border: 1px solid rgba(255,255,255,0.08); border-radius: 16px; padding: 40px; box-shadow: 0 20px 60px rgba(0,0,0,0.5);';
const EMAIL_LOGO = '<div style="font-size: 28px; font-weight: 800; letter-spacing: -0.04em; margin-bottom: 24px;">Automatyn<span style="color: #22d3ee;">.</span></div>';
const EMAIL_DIVIDER = '<hr style="border: none; border-top: 1px solid rgba(255,255,255,0.08); margin: 32px 0;">';

function emailFooter(unsubscribeNote) {
  return `${EMAIL_DIVIDER}
    <table style="width: 100%; border: 0;"><tr>
      <td style="padding: 0;">
        <p style="color: #52525b; font-size: 12px; margin: 0 0 12px; line-height: 1.5;">${unsubscribeNote}</p>
        <p style="color: #3f3f46; font-size: 11px; margin: 0; line-height: 1.5;">
          Automatyn &mdash; AI WhatsApp receptionist for small businesses<br>
          <a href="https://automatyn.co" style="color: #22d3ee; text-decoration: none;">automatyn.co</a>
        </p>
      </td>
    </tr></table>`;
}

function greenBtn(href, text) {
  return `<a href="${href}" style="display: inline-block; background: linear-gradient(180deg, #85e6b5 0%, #5dd492 100%); color: #0a0a0a; padding: 14px 32px; border-radius: 9999px; text-decoration: none; font-weight: 700; font-size: 15px; box-shadow: 0 0 20px rgba(117,224,167,0.25);">${text}</a>`;
}

function cyanBtn(href, text) {
  return `<a href="${href}" style="display: inline-block; background: linear-gradient(180deg, #22d3ee 0%, #0891b2 100%); color: #030303; padding: 14px 32px; border-radius: 9999px; text-decoration: none; font-weight: 700; font-size: 15px; box-shadow: 0 0 20px rgba(34,211,238,0.25);">${text}</a>`;
}

function emailWrap(content, footerNote) {
  return `<!DOCTYPE html>
<html><body style="${EMAIL_BODY}">
  <div style="${EMAIL_CARD}">
    ${EMAIL_LOGO}
    ${content}
    ${emailFooter(footerNote)}
  </div>
</body></html>`;
}

// ============ Transactional email templates ============
function verificationEmailHtml(verifyUrl) {
  return emailWrap(`
    <h1 style="font-size: 22px; font-weight: 700; margin: 0 0 12px; color: #fff;">Verify your email</h1>
    <p style="color: #a1a1aa; line-height: 1.6; margin: 0 0 28px; font-size: 15px;">Confirm your email to activate your Automatyn account. This link expires in 24 hours.</p>
    ${greenBtn(verifyUrl, 'Verify email')}
    <p style="color: #71717a; font-size: 13px; margin: 28px 0 0; line-height: 1.6;">Or copy this link:<br><span style="color: #a1a1aa; word-break: break-all;">${verifyUrl}</span></p>`,
    "Didn't sign up? Ignore this email."
  );
}

function resetEmailHtml(resetUrl) {
  return emailWrap(`
    <h1 style="font-size: 22px; font-weight: 700; margin: 0 0 12px; color: #fff;">Reset your password</h1>
    <p style="color: #a1a1aa; line-height: 1.6; margin: 0 0 28px; font-size: 15px;">Someone requested a password reset for your account. This link expires in 1 hour.</p>
    ${cyanBtn(resetUrl, 'Reset password')}
    <p style="color: #71717a; font-size: 13px; margin: 28px 0 0; line-height: 1.6;">Or copy this link:<br><span style="color: #a1a1aa; word-break: break-all;">${resetUrl}</span></p>`,
    "Didn't request this? Ignore the email; your password is unchanged."
  );
}

function magicLinkEmailHtml(loginUrl, isNewUser) {
  const headline = isNewUser ? 'Welcome to Automatyn' : 'Your sign-in link';
  const subtext = isNewUser
    ? 'Click the button below to finish creating your account. Link expires in 15 minutes.'
    : 'Click the button below to sign in. Link expires in 15 minutes.';
  const cta = isNewUser ? 'Finish signing up' : 'Sign in';
  return emailWrap(`
    <h1 style="font-size: 22px; font-weight: 700; margin: 0 0 12px; color: #fff;">${headline}</h1>
    <p style="color: #a1a1aa; line-height: 1.6; margin: 0 0 28px; font-size: 15px;">${subtext}</p>
    ${greenBtn(loginUrl, cta)}
    <p style="color: #71717a; font-size: 13px; margin: 28px 0 0; line-height: 1.6;">Or copy this link:<br><span style="color: #a1a1aa; word-break: break-all;">${loginUrl}</span></p>`,
    "Didn't request this? Ignore the email; no action will be taken."
  );
}

// ============ Welcome + onboarding sequence ============
function welcomeEmailHtml() {
  return emailWrap(`
    <h1 style="font-size: 22px; font-weight: 700; margin: 0 0 12px; color: #fff;">You're in. Here's what to do next.</h1>
    <p style="color: #a1a1aa; line-height: 1.6; margin: 0 0 20px; font-size: 15px;">Your AI receptionist is ready. Three quick steps to go live:</p>
    <table style="width: 100%; border: 0; border-spacing: 0 12px;">
      <tr><td style="padding: 16px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); border-radius: 12px;">
        <div style="font-size: 13px; color: #22d3ee; font-weight: 700; margin-bottom: 6px;">STEP 1</div>
        <div style="color: #e5e5e5; font-size: 14px; font-weight: 600;">Fill in your business details</div>
        <div style="color: #71717a; font-size: 13px; margin-top: 4px;">Services, prices, hours. This is what your AI uses to answer customer questions.</div>
      </td></tr>
      <tr><td style="padding: 16px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); border-radius: 12px;">
        <div style="font-size: 13px; color: #22d3ee; font-weight: 700; margin-bottom: 6px;">STEP 2</div>
        <div style="color: #e5e5e5; font-size: 14px; font-weight: 600;">Connect WhatsApp</div>
        <div style="color: #71717a; font-size: 13px; margin-top: 4px;">Scan a QR code or enter your phone number. Takes 30 seconds.</div>
      </td></tr>
      <tr><td style="padding: 16px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); border-radius: 12px;">
        <div style="font-size: 13px; color: #22d3ee; font-weight: 700; margin-bottom: 6px;">STEP 3</div>
        <div style="color: #e5e5e5; font-size: 14px; font-weight: 600;">Send a test message</div>
        <div style="color: #71717a; font-size: 13px; margin-top: 4px;">Message your own number from another phone to see your AI in action.</div>
      </td></tr>
    </table>
    <div style="margin-top: 28px;">
      ${greenBtn('https://automatyn.co/dashboard.html', 'Open your dashboard')}
    </div>`,
    'You received this because you signed up for Automatyn. <a href="https://automatyn.co" style="color: #52525b;">Unsubscribe</a>'
  );
}

function nudgeWhatsAppEmailHtml() {
  return emailWrap(`
    <h1 style="font-size: 22px; font-weight: 700; margin: 0 0 12px; color: #fff;">Have you connected WhatsApp yet?</h1>
    <p style="color: #a1a1aa; line-height: 1.6; margin: 0 0 20px; font-size: 15px;">Your AI receptionist is set up but not connected to WhatsApp. Until you connect, it can't answer customer messages.</p>
    <div style="padding: 20px; background: rgba(34,211,238,0.05); border: 1px solid rgba(34,211,238,0.15); border-radius: 12px; margin-bottom: 28px;">
      <div style="color: #22d3ee; font-weight: 700; font-size: 14px; margin-bottom: 8px;">It takes 30 seconds</div>
      <div style="color: #a1a1aa; font-size: 14px; line-height: 1.5;">Open your dashboard, go to the <strong style="color: #e5e5e5;">Setup</strong> tab, and scan the QR code with WhatsApp on your phone. That's it.</div>
    </div>
    ${greenBtn('https://automatyn.co/dashboard.html', 'Connect now')}`,
    'You received this because you signed up for Automatyn. <a href="https://automatyn.co" style="color: #52525b;">Unsubscribe</a>'
  );
}

function socialProofEmailHtml(industry) {
  const example = INDUSTRY_EXAMPLES[industry] || INDUSTRY_EXAMPLES['default'];
  return emailWrap(`
    <h1 style="font-size: 22px; font-weight: 700; margin: 0 0 12px; color: #fff;">How businesses like yours use Automatyn</h1>
    <p style="color: #a1a1aa; line-height: 1.6; margin: 0 0 24px; font-size: 15px;">${example.intro}</p>
    <div style="padding: 20px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); border-radius: 12px; margin-bottom: 12px;">
      <div style="color: #10b981; font-size: 13px; font-weight: 700; margin-bottom: 8px;">CUSTOMER</div>
      <div style="color: #e5e5e5; font-size: 14px; line-height: 1.5;">${example.customerMsg}</div>
    </div>
    <div style="padding: 20px; background: rgba(34,211,238,0.04); border: 1px solid rgba(34,211,238,0.12); border-radius: 12px; margin-bottom: 28px;">
      <div style="color: #22d3ee; font-size: 13px; font-weight: 700; margin-bottom: 8px;">YOUR AI</div>
      <div style="color: #e5e5e5; font-size: 14px; line-height: 1.5;">${example.aiReply}</div>
    </div>
    <p style="color: #a1a1aa; line-height: 1.6; margin: 0 0 28px; font-size: 15px;">${example.closer}</p>
    ${greenBtn('https://automatyn.co/dashboard.html', 'Check your dashboard')}`,
    'You received this because you signed up for Automatyn. <a href="https://automatyn.co" style="color: #52525b;">Unsubscribe</a>'
  );
}

const INDUSTRY_EXAMPLES = {
  'default': {
    intro: 'Your AI receptionist handles the conversations that usually eat into your day. Pricing questions, availability checks, booking requests.',
    customerMsg: 'Hi, how much do you charge and are you available this week?',
    aiReply: 'Thanks for reaching out! Our standard service starts at [your price]. We have availability on Thursday afternoon and Friday morning. Would either of those work for you?',
    closer: 'That reply happens instantly, 24/7. No missed leads while you are busy working.',
  },
  'Plumbing & heating': {
    intro: 'Plumbing businesses miss calls all the time because they are on a job. Your AI handles those enquiries the moment they come in.',
    customerMsg: "Hi, my boiler's not heating water. Do you do repairs and what's your callout charge?",
    aiReply: "Sorry to hear that! Yes, we handle boiler repairs. Our callout fee is [your price] which includes the first hour of labour. We have availability tomorrow morning. Want me to book you in?",
    closer: 'That customer would have called someone else if they had to wait 3 hours for a reply.',
  },
  'Hair & beauty salon': {
    intro: 'Salons get a flood of WhatsApp messages asking about prices and availability. Your AI handles all of that so you can focus on clients in the chair.',
    customerMsg: 'Do you have any availability for a cut and colour this Saturday?',
    aiReply: "We'd love to have you in! We have slots available at 10am and 2pm this Saturday. A cut and colour starts at [your price]. Shall I book one of those for you?",
    closer: 'Saturday bookings filled automatically while you were doing a blowdry.',
  },
  'Cleaning': {
    intro: 'Cleaning businesses live and die on response speed. When someone wants a quote, the first company to reply wins.',
    customerMsg: "Hi, I need a deep clean for a 3-bed house. What's your rate?",
    aiReply: "Hi! A deep clean for a 3-bedroom house starts from [your price]. This includes all rooms, kitchen and bathrooms. We can usually book within 2-3 days. When works best for you?",
    closer: 'That lead came in at 11pm on a Tuesday. Your AI replied in seconds.',
  },
  'Restaurant / café': {
    intro: 'Restaurants get WhatsApp messages about menus, opening hours, reservations, and allergen info. Your AI handles all of it without tying up staff.',
    customerMsg: 'Do you have any tables for 4 this Friday evening? Also, is there a vegan option?',
    aiReply: "Yes, we have availability for 4 this Friday! We can seat you at 7pm or 8:30pm. We have several vegan dishes including [your items]. Shall I reserve a table?",
    closer: 'That booking happened while your team was in the middle of a dinner rush.',
  },
};

function upgradeNudgeEmailHtml() {
  return emailWrap(`
    <h1 style="font-size: 22px; font-weight: 700; margin: 0 0 12px; color: #fff;">You're on the free plan. Here's what you're missing.</h1>
    <p style="color: #a1a1aa; line-height: 1.6; margin: 0 0 24px; font-size: 15px;">Your free plan includes 25 conversations per month. If you're starting to get real customer enquiries, here's what upgrading gets you:</p>
    <table style="width: 100%; border: 0; border-spacing: 0 8px;">
      <tr><td style="padding: 14px 16px; background: rgba(16,185,129,0.06); border: 1px solid rgba(16,185,129,0.15); border-radius: 10px;">
        <div style="color: #10b981; font-weight: 700; font-size: 14px;">Pro &mdash; $29/mo</div>
        <div style="color: #a1a1aa; font-size: 13px; margin-top: 4px;">150 conversations/mo, lead capture, booking system, priority support</div>
      </td></tr>
      <tr><td style="padding: 14px 16px; background: rgba(34,211,238,0.06); border: 1px solid rgba(34,211,238,0.15); border-radius: 10px;">
        <div style="color: #22d3ee; font-weight: 700; font-size: 14px;">Max &mdash; $79/mo</div>
        <div style="color: #a1a1aa; font-size: 13px; margin-top: 4px;">Unlimited conversations, everything in Pro, white-glove onboarding</div>
      </td></tr>
    </table>
    <div style="margin-top: 28px;">
      ${greenBtn('https://automatyn.co/dashboard.html', 'Upgrade now')}
    </div>
    <p style="color: #71717a; font-size: 13px; margin: 20px 0 0; line-height: 1.6;">No contracts. Cancel anytime. Your AI keeps running on the free plan if you don't upgrade.</p>`,
    'You received this because you signed up for Automatyn. <a href="https://automatyn.co" style="color: #52525b;">Unsubscribe</a>'
  );
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
  loadMagicLinkTokens, saveMagicLinkTokens,
  checkHibp, validEmail, validPassword,
  generateToken, sendEmail, addContactToList,
  verificationEmailHtml, resetEmailHtml, magicLinkEmailHtml,
  welcomeEmailHtml, nudgeWhatsAppEmailHtml, socialProofEmailHtml, upgradeNudgeEmailHtml,
  rateLimit, hashPassword, verifyPassword,
  DUMMY_HASH,
  VERIFY_TOKEN_TTL_MS, RESET_TOKEN_TTL_MS, MAGIC_LINK_TOKEN_TTL_MS, UNVERIFIED_OVERWRITE_AFTER_MS,
  BREVO_LIST_SIGNUPS, BREVO_LIST_GUIDE, BREVO_LIST_DEMO,
};
