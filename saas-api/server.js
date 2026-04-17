const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { provisionAgent, updateAgent, getAgent, DATA_DIR } = require('./provision');
const { startPairingCode, startQrPairing, checkPairingStatus, isWhatsAppConnected } = require('./whatsapp');
const authLib = require('./auth');
const fs = require('fs');
const path = require('path');

const https = require('https');
const APP_URL = process.env.APP_URL || 'https://automatyn.co';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;

const app = express();
const PORT = process.env.SAAS_API_PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const DODO_API_KEY = process.env.DODO_API_KEY;
const DODO_WEBHOOK_SECRET = process.env.DODO_WEBHOOK_SECRET;
const DODO_API_BASE = 'https://live.dodopayments.com';
const DODO_PRODUCT_PRO = 'pdt_0NcooRMOGyOxO7roCiSmn';
const DODO_PRODUCT_MAX = 'pdt_0NcooSqClvpfz5UfxgLcS';

// Paddle (primary payment provider)
const PADDLE_API_KEY = process.env.PADDLE_API_KEY;
const PADDLE_WEBHOOK_SECRET = process.env.PADDLE_WEBHOOK_SECRET;
const PADDLE_API_BASE = 'https://api.paddle.com';
const PADDLE_PRICE_PRO = 'pri_01kp9nmg87gyapxj153wv8t4y9';   // $29/mo
const PADDLE_PRICE_MAX = 'pri_01kp9nmhq88fnny2ha7b37yxy2';   // $79/mo

// Save JWT_SECRET to a file so it persists across restarts
const secretPath = path.join(__dirname, '.jwt-secret');
let jwtSecret = JWT_SECRET;
if (fs.existsSync(secretPath)) {
  jwtSecret = fs.readFileSync(secretPath, 'utf-8').trim();
} else {
  fs.writeFileSync(secretPath, jwtSecret);
}

// --- Structured request logging ---
const LOG_FILE = path.join(__dirname, 'logs', 'api.log');
fs.mkdirSync(path.join(__dirname, 'logs'), { recursive: true });
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });

function log(level, msg, meta = {}) {
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...meta
  });
  logStream.write(entry + '\n');
  if (level === 'error') console.error(entry);
}

// Log every request + response
app.use((req, res, next) => {
  const start = Date.now();
  const originalEnd = res.end;
  res.end = function(...args) {
    const duration = Date.now() - start;
    log('info', 'request', {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration,
      ip: req.ip || req.connection.remoteAddress,
      ua: (req.headers['user-agent'] || '').slice(0, 120),
    });
    originalEnd.apply(res, args);
  };
  next();
});

app.use(cors({
  origin: ['https://automatyn.co', 'https://automatyn.github.io', 'http://localhost:8080'],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Raw body for webhook signature verification
app.use('/api/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '100kb' }));

// Rate limiting (simple in-memory)
const signupAttempts = new Map();
function rateLimit(ip, max, windowMs) {
  const now = Date.now();
  const attempts = signupAttempts.get(ip) || [];
  const recent = attempts.filter(t => now - t < windowMs);
  if (recent.length >= max) return false;
  recent.push(now);
  signupAttempts.set(ip, recent);
  return true;
}

// Auth middleware
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization token' });
  }
  try {
    const decoded = jwt.verify(header.slice(7), jwtSecret);
    req.agentId = decoded.agentId;
    req.email = decoded.email;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Validate required fields
function validateSignup(body) {
  const required = ['email', 'businessName', 'industry', 'services', 'hours'];
  const missing = required.filter(f => !body[f] || !body[f].trim());
  if (missing.length > 0) {
    return `Missing required fields: ${missing.join(', ')}`;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
    return 'Invalid email address';
  }
  return null;
}

// ============================================================
// AUTH ENDPOINTS
// ============================================================

function issueJwt(user) {
  return jwt.sign(
    { agentId: user.agentId, email: user.email, verified: !!user.verified },
    jwtSecret,
    { expiresIn: '30d' }
  );
}

function genericDelay() {
  // Add random 100-300ms delay to prevent timing attacks
  return new Promise((r) => setTimeout(r, 100 + Math.random() * 200));
}

// POST /api/auth/register — Create account with email + password
app.post('/api/auth/register', async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';
  const plan = ['starter', 'pro', 'max'].includes(req.body.plan) ? req.body.plan : 'starter';

  // Rate limit
  if (!authLib.rateLimit(`register:ip:${ip}`, 5, 3600000)) {
    return res.status(429).json({ error: 'Too many attempts from this IP. Try again later.' });
  }
  if (!authLib.rateLimit(`register:email:${email}`, 3, 3600000)) {
    return res.status(429).json({ error: 'Too many attempts for this email. Try again later.' });
  }

  // Validate
  if (!authLib.validEmail(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  const pwCheck = authLib.validPassword(password);
  if (!pwCheck.ok) {
    return res.status(400).json({ error: pwCheck.error });
  }

  // Breach check (fails-open on network error)
  const isBreached = await authLib.checkHibp(password);
  if (isBreached) {
    return res.status(400).json({
      error: 'This password has appeared in a known data breach. Please choose a different one.'
    });
  }

  // Check existing user
  const existing = authLib.getUser(email);
  if (existing) {
    if (existing.verified) {
      // Case 1: Verified account exists - reject
      return res.status(409).json({ error: 'An account already exists with that email. Please sign in.' });
    }
    // Unverified - check age
    const age = Date.now() - new Date(existing.createdAt).getTime();
    if (age < authLib.UNVERIFIED_OVERWRITE_AFTER_MS) {
      // Case 2: Unverified + recent - resend verification
      try {
        const token = authLib.generateToken();
        const tokens = authLib.loadVerifyTokens();
        tokens[token] = { email, expiresAt: Date.now() + authLib.VERIFY_TOKEN_TTL_MS };
        authLib.saveVerifyTokens(tokens);
        const verifyUrl = `${APP_URL}/verify.html?token=${token}`;
        await authLib.sendEmail({
          to: email,
          subject: 'Verify your Automatyn email',
          htmlContent: authLib.verificationEmailHtml(verifyUrl),
        });
      } catch (err) {
        console.error('Resend verification email failed:', err.message);
      }
      return res.json({
        success: true,
        resent: true,
        message: "We've re-sent your verification email. Please check your inbox.",
      });
    }
    // Case 3: Unverified + old - overwrite
  }

  try {
    const passwordHash = await authLib.hashPassword(password);

    // Create agent shell (empty business details — will be filled during onboarding)
    const metadata = provisionAgent({
      email, businessName: '', industry: '', services: '', prices: '',
      hours: '', location: '', policies: '', plan,
    });

    const user = {
      email,
      passwordHash,
      verified: false,
      agentId: metadata.agentId,
      plan,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    authLib.setUser(email, user);

    // Generate verification token
    const token = authLib.generateToken();
    const tokens = authLib.loadVerifyTokens();
    tokens[token] = { email, expiresAt: Date.now() + authLib.VERIFY_TOKEN_TTL_MS };
    authLib.saveVerifyTokens(tokens);

    // Send verification email (non-blocking for UX — but we await to catch errors)
    const verifyUrl = `${APP_URL}/verify.html?token=${token}`;
    authLib.sendEmail({
      to: email,
      subject: 'Verify your Automatyn email',
      htmlContent: authLib.verificationEmailHtml(verifyUrl),
    }).catch((err) => console.error('Verification email send failed:', err.message));

    // Issue JWT immediately — user gets dashboard access right away
    const jwtToken = issueJwt(user);

    res.json({
      success: true,
      agentId: metadata.agentId,
      token: jwtToken,
      email,
      verified: false,
      plan,
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Failed to create account. Please try again.' });
  }
});

// POST /api/auth/login — Email + password login
app.post('/api/auth/login', async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';

  if (!authLib.rateLimit(`login:ip:${ip}`, 10, 3600000)) {
    return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
  }
  if (!authLib.rateLimit(`login:email:${email}`, 5, 3600000)) {
    return res.status(429).json({ error: 'Too many login attempts for this email. Try again later.' });
  }

  if (!authLib.validEmail(email) || !password) {
    // Still do a bcrypt comparison to avoid timing attacks
    await authLib.verifyPassword('dummy', authLib.DUMMY_HASH);
    await genericDelay();
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  const user = authLib.getUser(email);
  const hash = user ? user.passwordHash : authLib.DUMMY_HASH;
  const ok = await authLib.verifyPassword(password, hash);

  if (!user || !ok) {
    await genericDelay();
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  const token = issueJwt(user);
  res.json({
    success: true,
    token,
    agentId: user.agentId,
    email: user.email,
    verified: !!user.verified,
    plan: user.plan || 'starter',
  });
});

// POST /api/auth/magic-link — Send one-time sign-in link
// Creates account if email is new (no password required)
app.post('/api/auth/magic-link', async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  const email = (req.body.email || '').trim().toLowerCase();
  const plan = ['starter', 'pro', 'max'].includes(req.body.plan) ? req.body.plan : 'starter';

  if (!authLib.rateLimit(`magiclink:ip:${ip}`, 10, 3600000)) {
    return res.status(429).json({ error: 'Too many requests from this IP. Try again later.' });
  }
  if (!authLib.rateLimit(`magiclink:email:${email}`, 5, 3600000)) {
    return res.status(429).json({ error: 'Too many sign-in requests for this email. Try again later.' });
  }

  if (!authLib.validEmail(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  let user = authLib.getUser(email);
  let isNewUser = false;

  // If no user, create a shell account on the fly
  if (!user) {
    isNewUser = true;
    try {
      const metadata = provisionAgent({
        email, businessName: '', industry: '', services: '', prices: '',
        hours: '', location: '', policies: '', plan,
      });
      user = {
        email,
        passwordHash: null, // magic-link users have no password
        verified: false,
        agentId: metadata.agentId,
        plan,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      authLib.setUser(email, user);
    } catch (err) {
      console.error('Magic-link account provision failed:', err);
      return res.status(500).json({ error: 'Failed to start sign-in. Please try again.' });
    }
  }

  // Generate one-time token
  const token = authLib.generateToken();
  const tokens = authLib.loadMagicLinkTokens();
  tokens[token] = {
    email,
    expiresAt: Date.now() + authLib.MAGIC_LINK_TOKEN_TTL_MS,
    isNewUser,
  };
  authLib.saveMagicLinkTokens(tokens);

  const loginUrl = `${APP_URL}/verify.html?magic=${token}`;

  try {
    await authLib.sendEmail({
      to: email,
      subject: isNewUser ? 'Finish signing up for Automatyn' : 'Your Automatyn sign-in link',
      htmlContent: authLib.magicLinkEmailHtml(loginUrl, isNewUser),
    });
  } catch (err) {
    console.error('Magic-link email send failed:', err.message);
    return res.status(500).json({ error: 'Could not send the sign-in email. Please try again.' });
  }

  res.json({
    success: true,
    message: "Check your inbox — we've sent you a link to sign in.",
    isNewUser,
  });
});

// POST /api/auth/magic-link/consume — Exchange one-time token for JWT
app.post('/api/auth/magic-link/consume', (req, res) => {
  const token = (req.body.token || '').trim();
  if (!token) return res.status(400).json({ error: 'Missing sign-in token.' });

  const tokens = authLib.loadMagicLinkTokens();
  const entry = tokens[token];
  if (!entry) return res.status(400).json({ error: 'This sign-in link has already been used or is invalid.' });
  if (entry.expiresAt < Date.now()) {
    delete tokens[token];
    authLib.saveMagicLinkTokens(tokens);
    return res.status(400).json({ error: 'This sign-in link has expired. Please request a new one.' });
  }

  const user = authLib.getUser(entry.email);
  if (!user) {
    delete tokens[token];
    authLib.saveMagicLinkTokens(tokens);
    return res.status(404).json({ error: 'Account not found.' });
  }

  // Magic-link success = email is verified (they own the inbox)
  const wasAlreadyVerified = user.verified;
  if (!user.verified) {
    user.verified = true;
    user.verifiedAt = new Date().toISOString();
  }
  user.lastLoginAt = new Date().toISOString();
  user.updatedAt = new Date().toISOString();
  authLib.setUser(entry.email, user);

  // Trigger welcome drip on first verification
  if (!wasAlreadyVerified) {
    const agent = getAgent(user.agentId);
    scheduleOnboardingDrip(entry.email, user.agentId, agent?.industry || '');
    authLib.addContactToList(entry.email, authLib.BREVO_LIST_SIGNUPS).catch(() => {});
  }

  // Consume the token (one-time use)
  delete tokens[token];
  authLib.saveMagicLinkTokens(tokens);

  const jwtToken = issueJwt(user);
  res.json({
    success: true,
    token: jwtToken,
    agentId: user.agentId,
    email: user.email,
    verified: true,
    plan: user.plan || 'starter',
    isNewUser: !!entry.isNewUser,
  });
});

// POST /api/auth/google — Sign in / sign up with Google ID token
app.post('/api/auth/google', async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  const credential = (req.body.credential || '').trim();
  const plan = ['starter', 'pro', 'max'].includes(req.body.plan) ? req.body.plan : 'starter';

  if (!credential) return res.status(400).json({ error: 'Missing Google credential.' });
  if (!authLib.rateLimit(`google:ip:${ip}`, 20, 3600000)) {
    return res.status(429).json({ error: 'Too many requests. Try again later.' });
  }

  // Verify the ID token with Google
  let payload;
  try {
    const verifyUrl = `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`;
    payload = await new Promise((resolve, reject) => {
      https.get(verifyUrl, (resp) => {
        let data = '';
        resp.on('data', c => data += c);
        resp.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error_description) return reject(new Error(parsed.error_description));
            resolve(parsed);
          } catch (e) { reject(e); }
        });
      }).on('error', reject);
    });
  } catch (err) {
    log('error', 'google_token_verify_failed', { error: err.message });
    return res.status(401).json({ error: 'Invalid Google credential. Please try again.' });
  }

  // Verify audience matches our client ID
  if (payload.aud !== GOOGLE_CLIENT_ID) {
    log('error', 'google_aud_mismatch', { got: payload.aud, expected: GOOGLE_CLIENT_ID ? 'set' : 'NOT_SET' });
    return res.status(401).json({ error: 'Invalid Google credential.' });
  }

  const email = (payload.email || '').toLowerCase();
  if (!email || payload.email_verified !== 'true') {
    return res.status(400).json({ error: 'Google account email not verified.' });
  }

  let user = authLib.getUser(email);
  let isNewUser = false;

  if (!user) {
    isNewUser = true;
    try {
      const metadata = provisionAgent({
        email, businessName: '', industry: '', services: '', prices: '',
        hours: '', location: '', policies: '', plan,
      });
      user = {
        email,
        passwordHash: null,
        verified: true,
        googleSub: payload.sub,
        name: payload.name || '',
        agentId: metadata.agentId,
        plan,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      authLib.setUser(email, user);
      // New Google user: trigger welcome drip + add to list
      scheduleOnboardingDrip(email, metadata.agentId, '');
      authLib.addContactToList(email, authLib.BREVO_LIST_SIGNUPS).catch(() => {});
    } catch (err) {
      console.error('Google sign-up provision failed:', err);
      return res.status(500).json({ error: 'Account creation failed. Please try again.' });
    }
  } else {
    // Existing user, update Google info if missing
    if (!user.googleSub) user.googleSub = payload.sub;
    if (!user.verified) { user.verified = true; user.verifiedAt = new Date().toISOString(); }
    user.lastLoginAt = new Date().toISOString();
    user.updatedAt = new Date().toISOString();
    authLib.setUser(email, user);
  }

  const jwtToken = issueJwt(user);
  res.json({
    success: true,
    token: jwtToken,
    agentId: user.agentId,
    email: user.email,
    verified: true,
    plan: user.plan || 'starter',
    isNewUser,
  });
});

// POST /api/auth/verify — Verify email via magic link token
app.post('/api/auth/verify', (req, res) => {
  const token = (req.body.token || '').trim();
  if (!token) return res.status(400).json({ error: 'Missing verification token.' });

  const tokens = authLib.loadVerifyTokens();
  const entry = tokens[token];
  if (!entry) return res.status(400).json({ error: 'Invalid or already-used verification link.' });
  if (entry.expiresAt < Date.now()) {
    delete tokens[token];
    authLib.saveVerifyTokens(tokens);
    return res.status(400).json({ error: 'This verification link has expired. Please request a new one.' });
  }

  const user = authLib.getUser(entry.email);
  if (!user) return res.status(404).json({ error: 'Account not found.' });

  const wasAlreadyVerified = user.verified;
  user.verified = true;
  user.verifiedAt = user.verifiedAt || new Date().toISOString();
  user.updatedAt = new Date().toISOString();
  authLib.setUser(entry.email, user);

  delete tokens[token];
  authLib.saveVerifyTokens(tokens);

  // Trigger welcome drip on first verification
  if (!wasAlreadyVerified) {
    const agent = getAgent(user.agentId);
    scheduleOnboardingDrip(entry.email, user.agentId, agent?.industry || '');
    authLib.addContactToList(entry.email, authLib.BREVO_LIST_SIGNUPS).catch(() => {});
  }

  const jwtToken = issueJwt(user);
  res.json({
    success: true,
    token: jwtToken,
    agentId: user.agentId,
    email: user.email,
    verified: true,
    plan: user.plan || 'starter',
  });
});

// POST /api/auth/resend-verification — Resend verification email
app.post('/api/auth/resend-verification', async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  const email = (req.body.email || '').trim().toLowerCase();

  if (!authLib.rateLimit(`resend:ip:${ip}`, 5, 3600000)) {
    return res.status(429).json({ error: 'Too many requests. Try again later.' });
  }
  if (!authLib.rateLimit(`resend:email:${email}`, 3, 3600000)) {
    return res.status(429).json({ error: 'Too many requests for this email. Try again later.' });
  }

  // Always return 200 to prevent email enumeration
  const user = authLib.getUser(email);
  if (user && !user.verified) {
    try {
      const token = authLib.generateToken();
      const tokens = authLib.loadVerifyTokens();
      tokens[token] = { email, expiresAt: Date.now() + authLib.VERIFY_TOKEN_TTL_MS };
      authLib.saveVerifyTokens(tokens);
      const verifyUrl = `${APP_URL}/verify.html?token=${token}`;
      await authLib.sendEmail({
        to: email,
        subject: 'Verify your Automatyn email',
        htmlContent: authLib.verificationEmailHtml(verifyUrl),
      });
    } catch (err) {
      console.error('Resend verification failed:', err.message);
    }
  }
  res.json({ success: true, message: "If your account exists and isn't verified, we've sent a new link." });
});

// POST /api/auth/forgot-password — Send reset link
app.post('/api/auth/forgot-password', async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  const email = (req.body.email || '').trim().toLowerCase();

  if (!authLib.rateLimit(`forgot:ip:${ip}`, 5, 3600000)) {
    return res.status(429).json({ error: 'Too many requests. Try again later.' });
  }
  if (!authLib.rateLimit(`forgot:email:${email}`, 3, 3600000)) {
    return res.status(429).json({ error: 'Too many requests for this email. Try again later.' });
  }

  // Always respond 200 to prevent enumeration
  const user = authLib.getUser(email);
  if (user && authLib.validEmail(email)) {
    try {
      const token = authLib.generateToken();
      const tokens = authLib.loadResetTokens();
      tokens[token] = { email, expiresAt: Date.now() + authLib.RESET_TOKEN_TTL_MS };
      authLib.saveResetTokens(tokens);
      const resetUrl = `${APP_URL}/reset-password.html?token=${token}`;
      await authLib.sendEmail({
        to: email,
        subject: 'Reset your Automatyn password',
        htmlContent: authLib.resetEmailHtml(resetUrl),
      });
    } catch (err) {
      console.error('Reset email send failed:', err.message);
    }
  }
  await genericDelay();
  res.json({ success: true, message: 'If your account exists, we have sent a password reset link.' });
});

// POST /api/auth/reset-password — Complete password reset
app.post('/api/auth/reset-password', async (req, res) => {
  const token = (req.body.token || '').trim();
  const password = req.body.password || '';

  if (!token) return res.status(400).json({ error: 'Missing reset token.' });
  const pwCheck = authLib.validPassword(password);
  if (!pwCheck.ok) return res.status(400).json({ error: pwCheck.error });

  const isBreached = await authLib.checkHibp(password);
  if (isBreached) {
    return res.status(400).json({
      error: 'This password has appeared in a known data breach. Please choose a different one.'
    });
  }

  const tokens = authLib.loadResetTokens();
  const entry = tokens[token];
  if (!entry) return res.status(400).json({ error: 'Invalid or already-used reset link.' });
  if (entry.expiresAt < Date.now()) {
    delete tokens[token];
    authLib.saveResetTokens(tokens);
    return res.status(400).json({ error: 'This reset link has expired. Please request a new one.' });
  }

  const user = authLib.getUser(entry.email);
  if (!user) return res.status(404).json({ error: 'Account not found.' });

  user.passwordHash = await authLib.hashPassword(password);
  user.updatedAt = new Date().toISOString();
  authLib.setUser(entry.email, user);

  delete tokens[token];
  authLib.saveResetTokens(tokens);

  const jwtToken = issueJwt(user);
  res.json({
    success: true,
    token: jwtToken,
    agentId: user.agentId,
    email: user.email,
    verified: !!user.verified,
    plan: user.plan || 'starter',
  });
});

// GET /api/auth/me — Get current user info (useful for banner state)
app.get('/api/auth/me', auth, (req, res) => {
  const user = authLib.getUser(req.email);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  res.json({
    email: user.email,
    agentId: user.agentId,
    verified: !!user.verified,
    plan: user.plan || 'starter',
  });
});

// Legacy /api/register and /api/signup endpoints removed (security: bypassed auth system)

// ============================================================
// POST /api/capture — Email capture for homepage forms (guide/demo)
// ============================================================
app.post('/api/capture', async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  if (!rateLimit(ip, 10, 3600000)) {
    return res.status(429).json({ error: 'Too many requests.' });
  }

  const email = (req.body.email || '').trim().toLowerCase();
  const source = req.body.source || 'guide'; // 'guide' or 'demo'

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email.' });
  }

  const listId = source === 'demo' ? authLib.BREVO_LIST_DEMO : authLib.BREVO_LIST_GUIDE;

  try {
    await authLib.addContactToList(email, listId, { SOURCE: source });
    log('info', 'email_captured', { source, email: email.slice(0, 3) + '***' });
    res.json({ success: true });
  } catch (err) {
    log('error', 'email_capture_failed', { error: err.message });
    // Still return success to user (don't block UX on Brevo errors)
    res.json({ success: true });
  }
});

// ============================================================
// Onboarding email drip scheduler
// ============================================================
const DRIP_FILE = path.join(DATA_DIR, 'email-drip.json');

function loadDripState() {
  try { return JSON.parse(fs.readFileSync(DRIP_FILE, 'utf-8')); }
  catch { return {}; }
}
function saveDripState(state) {
  fs.writeFileSync(DRIP_FILE, JSON.stringify(state, null, 2));
}

// Schedule onboarding drip for a newly verified user
function scheduleOnboardingDrip(email, agentId, industry) {
  const state = loadDripState();
  if (state[email]?.welcomeSent) return; // Already started

  state[email] = { agentId, industry: industry || '', welcomeSent: false, steps: {} };
  saveDripState(state);

  // Email 1: Welcome (immediate)
  sendDripEmail(email, 'welcome', 0);
  // Email 2: WhatsApp nudge (2 days)
  sendDripEmail(email, 'whatsapp_nudge', 2 * 24 * 60 * 60 * 1000);
  // Email 3: Social proof (4 days)
  sendDripEmail(email, 'social_proof', 4 * 24 * 60 * 60 * 1000);
  // Email 4: Upgrade nudge (7 days)
  sendDripEmail(email, 'upgrade_nudge', 7 * 24 * 60 * 60 * 1000);
}

function sendDripEmail(email, step, delayMs) {
  setTimeout(async () => {
    const state = loadDripState();
    const entry = state[email];
    if (!entry || entry.steps?.[step]) return; // Already sent or user removed

    // Skip nudge emails if user already upgraded or connected
    if (step === 'upgrade_nudge') {
      const user = authLib.getUser(email);
      if (user && user.plan !== 'starter') return;
    }
    if (step === 'whatsapp_nudge') {
      const agent = getAgent(entry.agentId);
      if (agent && agent.whatsappConnected) return;
    }

    let subject, html;
    switch (step) {
      case 'welcome':
        subject = "You're in. Here's how to go live in 3 steps";
        html = authLib.welcomeEmailHtml();
        break;
      case 'whatsapp_nudge':
        subject = 'Your AI is waiting for WhatsApp';
        html = authLib.nudgeWhatsAppEmailHtml();
        break;
      case 'social_proof':
        subject = 'How businesses like yours use Automatyn';
        html = authLib.socialProofEmailHtml(entry.industry);
        break;
      case 'upgrade_nudge':
        subject = "You're on the free plan. Here's what you're missing";
        html = authLib.upgradeNudgeEmailHtml();
        break;
      default: return;
    }

    try {
      await authLib.sendEmail({ to: email, subject, htmlContent: html });
      entry.steps = entry.steps || {};
      entry.steps[step] = new Date().toISOString();
      if (step === 'welcome') entry.welcomeSent = true;
      saveDripState(state);
      log('info', 'drip_email_sent', { email: email.slice(0, 3) + '***', step });
    } catch (err) {
      log('error', 'drip_email_failed', { step, error: err.message });
    }
  }, delayMs);
}

// On startup: reschedule any pending drip emails
(function resumePendingDrips() {
  const state = loadDripState();
  const steps = ['welcome', 'whatsapp_nudge', 'social_proof', 'upgrade_nudge'];
  const delays = { welcome: 0, whatsapp_nudge: 2*86400000, social_proof: 4*86400000, upgrade_nudge: 7*86400000 };

  for (const [email, entry] of Object.entries(state)) {
    if (!entry.welcomeSent) {
      // Never got welcome email, restart full sequence
      for (const s of steps) {
        if (!entry.steps?.[s]) sendDripEmail(email, s, delays[s]);
      }
    } else {
      // Resume remaining steps
      for (const s of steps) {
        if (!entry.steps?.[s]) {
          // Calculate remaining delay from when welcome was sent
          const welcomeTime = new Date(entry.steps?.welcome || Date.now()).getTime();
          const remaining = Math.max(0, delays[s] - (Date.now() - welcomeTime));
          sendDripEmail(email, s, remaining);
        }
      }
    }
  }
})();

// ============================================================
// POST /api/webhook/dodo — DodoPayments webhook (Standard Webhooks spec)
// ============================================================
app.post('/api/webhook/dodo', (req, res) => {
  // Verify signature — FAIL CLOSED: reject if secret is not configured
  if (!DODO_WEBHOOK_SECRET) {
    log('error', 'dodo_webhook_secret_missing');
    return res.status(500).json({ error: 'Webhook verification not configured' });
  }
  const webhookId = req.headers['webhook-id'] || '';
  const webhookTs = req.headers['webhook-timestamp'] || '';
  const webhookSig = req.headers['webhook-signature'] || '';
  const body = req.body.toString();
  const payload = `${webhookId}.${webhookTs}.${body}`;
  const secretBytes = Buffer.from(DODO_WEBHOOK_SECRET.replace(/^whsec_/, ''), 'base64');
  const expected = 'v1,' + crypto.createHmac('sha256', secretBytes).update(payload).digest('base64');
  const signatures = webhookSig.split(' ');
  if (!signatures.some(s => s === expected)) {
    log('error', 'dodo_webhook_sig_mismatch');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  try {
    const event = JSON.parse(req.body.toString());
    const eventType = event.type;
    const data = event.data;

    log('info', 'dodo_webhook', { event: eventType });

    const agentId = data?.metadata?.agent_id;

    if (!agentId) {
      log('warn', 'dodo_webhook_no_agent_id');
      return res.json({ received: true });
    }

    const agent = getAgent(agentId);
    if (!agent) {
      log('warn', 'dodo_webhook_unknown_agent', { agentId });
      return res.json({ received: true });
    }

    const metaPath = path.join(DATA_DIR, `${agentId}.json`);

    if (eventType === 'subscription.active' || eventType === 'subscription.renewed' || eventType === 'payment.succeeded') {
      const productId = data.product_id || data.product?.product_id || '';
      agent.plan = productId === DODO_PRODUCT_MAX ? 'max' : 'pro';
      agent.status = 'active';
      agent.dodoSubscriptionId = data.subscription_id || data.id;
      agent.updatedAt = new Date().toISOString();
      fs.writeFileSync(metaPath, JSON.stringify(agent, null, 2));
      log('info', 'agent_upgraded', { agentId, plan: agent.plan });
    }

    if (eventType === 'subscription.cancelled' || eventType === 'subscription.expired' || eventType === 'subscription.failed') {
      agent.plan = 'starter';
      agent.status = 'canceled';
      agent.updatedAt = new Date().toISOString();
      fs.writeFileSync(metaPath, JSON.stringify(agent, null, 2));
      log('info', 'agent_downgraded', { agentId });
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Dodo webhook error:', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// ============================================================
// POST /api/webhook/paddle — Paddle webhook (Paddle Billing)
// ============================================================
app.post('/api/webhook/paddle', (req, res) => {
  // Verify signature — FAIL CLOSED
  if (!PADDLE_WEBHOOK_SECRET) {
    log('error', 'paddle_webhook_secret_missing');
    return res.status(500).json({ error: 'Webhook verification not configured' });
  }

  const signature = req.headers['paddle-signature'] || '';
  const body = req.body.toString();

  // Parse Paddle signature: ts=xxx;h1=xxx
  const parts = {};
  signature.split(';').forEach(p => {
    const [k, v] = p.split('=');
    if (k && v) parts[k] = v;
  });

  if (!parts.ts || !parts.h1) {
    log('error', 'paddle_webhook_sig_missing');
    return res.status(401).json({ error: 'Missing signature components' });
  }

  const payload = `${parts.ts}:${body}`;
  const expected = crypto.createHmac('sha256', PADDLE_WEBHOOK_SECRET).update(payload).digest('hex');

  if (expected !== parts.h1) {
    log('error', 'paddle_webhook_sig_mismatch');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  try {
    const event = JSON.parse(body);
    const eventType = event.event_type;
    const data = event.data;

    log('info', 'paddle_webhook', { event: eventType });

    const agentId = data?.custom_data?.agent_id;
    if (!agentId) {
      log('warn', 'paddle_webhook_no_agent_id');
      return res.json({ received: true });
    }

    const agent = getAgent(agentId);
    if (!agent) {
      log('warn', 'paddle_webhook_unknown_agent', { agentId });
      return res.json({ received: true });
    }

    const metaPath = path.join(DATA_DIR, `${agentId}.json`);

    if (eventType === 'subscription.created' || eventType === 'subscription.updated' || eventType === 'transaction.completed') {
      // Determine plan from price ID in items
      const items = data.items || [];
      const priceId = items[0]?.price?.id || '';
      agent.plan = priceId === PADDLE_PRICE_MAX ? 'max' : 'pro';
      agent.status = 'active';
      agent.paddleSubscriptionId = data.id;
      agent.paddleCustomerId = data.customer_id;
      agent.updatedAt = new Date().toISOString();
      fs.writeFileSync(metaPath, JSON.stringify(agent, null, 2));

      // Also update the user record's plan
      const user = authLib.getUser(agent.email);
      if (user) {
        user.plan = agent.plan;
        user.updatedAt = new Date().toISOString();
        authLib.setUser(agent.email, user);
      }

      log('info', 'agent_upgraded_paddle', { agentId, plan: agent.plan });
    }

    if (eventType === 'subscription.canceled' || eventType === 'subscription.past_due' || eventType === 'transaction.payment_failed') {
      if (eventType === 'subscription.canceled') {
        agent.plan = 'starter';
        agent.status = 'canceled';
      } else {
        agent.status = 'past_due';
      }
      agent.updatedAt = new Date().toISOString();
      fs.writeFileSync(metaPath, JSON.stringify(agent, null, 2));

      if (eventType === 'subscription.canceled') {
        const user = authLib.getUser(agent.email);
        if (user) {
          user.plan = 'starter';
          user.updatedAt = new Date().toISOString();
          authLib.setUser(agent.email, user);
        }
      }

      log('info', 'agent_downgraded_paddle', { agentId, plan: agent.plan, status: agent.status });
    }

    res.json({ received: true });
  } catch (err) {
    log('error', 'paddle_webhook_error', { error: err.message });
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// ============================================================
// POST /api/checkout — Create Paddle checkout (transaction)
// ============================================================
app.post('/api/checkout', auth, async (req, res) => {
  const { plan } = req.body;
  const priceIds = {
    pro: PADDLE_PRICE_PRO,
    max: PADDLE_PRICE_MAX,
  };

  const priceId = priceIds[plan];
  if (!priceId) {
    return res.status(400).json({ error: 'Invalid plan. Use "pro" or "max".' });
  }

  if (!PADDLE_API_KEY) {
    log('error', 'paddle_api_key_missing');
    return res.status(500).json({ error: 'Payment provider not configured' });
  }

  const agent = getAgent(req.agentId);
  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  try {
    const response = await fetch(`${PADDLE_API_BASE}/transactions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${PADDLE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        items: [{ price_id: priceId, quantity: 1 }],
        custom_data: { agent_id: req.agentId },
        checkout: {
          url: `https://automatyn.co/dashboard.html?upgraded=${plan}`,
        },
        customer_email: agent.email || req.email,
      }),
    });

    const result = await response.json();
    if (!response.ok) {
      log('error', 'paddle_checkout_error', { status: response.status, body: result });
      return res.status(500).json({ error: 'Failed to create checkout session' });
    }

    const checkoutUrl = result.data?.checkout?.url;
    if (!checkoutUrl) {
      log('error', 'paddle_no_checkout_url', { result: result.data });
      return res.status(500).json({ error: 'Failed to create checkout session' });
    }

    res.json({ checkoutUrl });
  } catch (err) {
    log('error', 'checkout_error', { error: err.message });
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// ============================================================
// GET /api/agent/:id — Get agent details
// ============================================================
app.get('/api/agent/:id', auth, (req, res) => {
  if (req.params.id !== req.agentId) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const agent = getAgent(req.params.id);
  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  // Don't leak sensitive fields
  const { lsSubscriptionId, dodoSubscriptionId, paddleSubscriptionId, paddleCustomerId, ...safe } = agent;
  res.json(safe);
});

// ============================================================
// PUT /api/agent/:id — Update agent details
// ============================================================
app.put('/api/agent/:id', auth, (req, res) => {
  if (req.params.id !== req.agentId) {
    return res.status(403).json({ error: 'Access denied' });
  }

  try {
    const updated = updateAgent(req.params.id, req.body);
    const { lsSubscriptionId, dodoSubscriptionId, paddleSubscriptionId, paddleCustomerId, ...safe } = updated;
    res.json({ success: true, agent: safe });
  } catch (err) {
    if (err.message === 'Agent not found') {
      return res.status(404).json({ error: 'Agent not found' });
    }
    console.error('Update error:', err);
    res.status(500).json({ error: 'Failed to update agent' });
  }
});

// ============================================================
// GET /api/agent/:id/status — Connection status + usage
// ============================================================
app.get('/api/agent/:id/status', auth, (req, res) => {
  if (req.params.id !== req.agentId) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const agent = getAgent(req.params.id);
  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  const limits = { starter: 25, pro: 150, max: -1 };

  // Compute range-filtered counts from leads (each lead = a conversation)
  const allLeads = loadLeads(req.params.id);
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);

  // Week start (Monday)
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  weekStart.setHours(0, 0, 0, 0);

  // Month start
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  // Year start
  const yearStart = new Date(now.getFullYear(), 0, 1);

  const countByRange = {
    today: allLeads.filter(l => (l.createdAt || '').slice(0, 10) === todayStr).length,
    week: allLeads.filter(l => l.createdAt && new Date(l.createdAt) >= weekStart).length,
    month: allLeads.filter(l => l.createdAt && new Date(l.createdAt) >= monthStart).length,
    year: allLeads.filter(l => l.createdAt && new Date(l.createdAt) >= yearStart).length,
  };

  // Build daily history for the last 30 days
  const history = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const ds = d.toISOString().slice(0, 10);
    history.push(allLeads.filter(l => (l.createdAt || '').slice(0, 10) === ds).length);
  }

  res.json({
    connected: agent.whatsappConnected || false,
    plan: agent.plan,
    conversationCount: agent.conversationCount || 0,
    conversationLimit: limits[agent.plan] || 25,
    resetDate: agent.conversationResetDate,
    countByRange,
    history,
  });
});

// Old /api/agent/:id/qr endpoint removed — use /api/agent/:id/whatsapp/qr or /whatsapp/pair instead

// ============================================================
// POST /api/agent/:id/whatsapp/pair — Start WhatsApp pairing (phone code)
// ============================================================
app.post('/api/agent/:id/whatsapp/pair', auth, async (req, res) => {
  if (req.params.id !== req.agentId) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const agent = getAgent(req.params.id);
  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  const phoneNumber = (req.body.phoneNumber || '').trim();
  if (!phoneNumber) {
    return res.status(400).json({ error: 'Phone number is required. Format: country code + number (e.g. 447700900000)' });
  }

  try {
    const result = await startPairingCode(req.params.id, phoneNumber);
    res.json(result);
  } catch (err) {
    console.error('WhatsApp pairing error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to start WhatsApp pairing' });
  }
});

// ============================================================
// GET /api/agent/:id/whatsapp/qr — Start WhatsApp pairing (QR code)
// ============================================================
app.get('/api/agent/:id/whatsapp/qr', auth, async (req, res) => {
  if (req.params.id !== req.agentId) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const agent = getAgent(req.params.id);
  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  try {
    const result = await startQrPairing(req.params.id);
    res.json(result);
  } catch (err) {
    console.error('WhatsApp QR error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to generate QR code' });
  }
});

// ============================================================
// GET /api/agent/:id/whatsapp/status — Check WhatsApp connection
// ============================================================
app.get('/api/agent/:id/whatsapp/status', auth, async (req, res) => {
  if (req.params.id !== req.agentId) {
    return res.status(403).json({ error: 'Access denied' });
  }

  try {
    const status = await checkPairingStatus(req.params.id);
    // Also update agent metadata if newly connected
    if (status.connected) {
      const metaPath = path.join(DATA_DIR, `${req.params.id}.json`);
      if (fs.existsSync(metaPath)) {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        if (!meta.whatsappConnected) {
          meta.whatsappConnected = true;
          meta.updatedAt = new Date().toISOString();
          fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
        }
      }
    }
    res.json(status);
  } catch (err) {
    console.error('WhatsApp status error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to check status' });
  }
});

// ============================================================
// LEADS ENDPOINTS
// ============================================================

const LEADS_DIR = path.join(__dirname, 'data', 'leads');
if (!fs.existsSync(LEADS_DIR)) fs.mkdirSync(LEADS_DIR, { recursive: true });

function getLeadsPath(agentId) {
  return path.join(LEADS_DIR, `${agentId}.json`);
}

function loadLeads(agentId) {
  const p = getLeadsPath(agentId);
  if (!fs.existsSync(p)) return [];
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return []; }
}

function saveLeads(agentId, leads) {
  fs.writeFileSync(getLeadsPath(agentId), JSON.stringify(leads, null, 2));
}

// GET /api/agent/:id/leads — List leads with optional filters
app.get('/api/agent/:id/leads', auth, (req, res) => {
  try {
    if (req.params.id !== req.agentId) return res.status(403).json({ error: 'Access denied' });

    let leads = loadLeads(req.params.id);

    // Filter by status
    if (req.query.status) {
      leads = leads.filter(l => l.status === req.query.status);
    }
    // Search by name, phone, email, notes
    if (req.query.q) {
      const q = req.query.q.toLowerCase();
      leads = leads.filter(l =>
        (l.name || '').toLowerCase().includes(q) ||
        (l.phone || '').toLowerCase().includes(q) ||
        (l.email || '').toLowerCase().includes(q) ||
        (l.notes || '').toLowerCase().includes(q)
      );
    }

    // Sort newest first
    leads.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    // Stats (reuse loaded leads instead of loading twice)
    const all = loadLeads(req.params.id);
    const today = new Date().toISOString().slice(0, 10);
    const stats = {
      total: all.length,
      newToday: all.filter(l => (l.createdAt || '').slice(0, 10) === today).length,
      needsFollowUp: all.filter(l => l.status === 'new' || l.status === 'contacted').length,
      converted: all.filter(l => l.status === 'won').length,
    };

    res.json({ leads, stats });
  } catch (err) {
    log('error', 'leads_list_error', { error: err.message });
    res.status(500).json({ error: 'Failed to load leads.' });
  }
});

// POST /api/agent/:id/leads — Create a lead (called by bot or manually)
app.post('/api/agent/:id/leads', auth, (req, res) => {
  try {
    if (req.params.id !== req.agentId) return res.status(403).json({ error: 'Access denied' });

    const { name, phone, email, notes, source } = req.body;
    if (!name && !phone && !email) {
      return res.status(400).json({ error: 'At least one of name, phone, or email is required.' });
    }

    const leads = loadLeads(req.params.id);
    const lead = {
      id: crypto.randomBytes(8).toString('hex'),
      name: (name || '').trim(),
      phone: (phone || '').trim(),
      email: (email || '').trim(),
      status: 'new',
      notes: (notes || '').trim(),
      source: (source || 'whatsapp').trim(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    leads.push(lead);
    saveLeads(req.params.id, leads);
    res.json({ success: true, lead });
  } catch (err) {
    log('error', 'lead_create_error', { error: err.message });
    res.status(500).json({ error: 'Failed to create lead.' });
  }
});

// POST /api/agent/:id/leads/ingest — Unauthenticated lead capture (called by OpenClaw bot)
app.post('/api/agent/:id/leads/ingest', (req, res) => {
  try {
    const agentId = req.params.id;
    const agent = getAgent(agentId);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const ingestToken = req.headers['x-ingest-token'] || '';
    if (!agent.ingestToken || ingestToken !== agent.ingestToken) {
      return res.status(401).json({ error: 'Invalid ingest token' });
    }

    const { name, phone, email, notes, source } = req.body;
    if (!name && !phone && !email) {
      return res.status(400).json({ error: 'At least one of name, phone, or email is required.' });
    }

    const leads = loadLeads(agentId);
    const lead = {
      id: crypto.randomBytes(8).toString('hex'),
      name: (name || '').trim(),
      phone: (phone || '').trim(),
      email: (email || '').trim(),
      status: 'new',
      notes: (notes || '').trim(),
      source: (source || 'whatsapp-bot').trim(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    leads.push(lead);
    saveLeads(agentId, leads);
    res.json({ success: true, lead });
  } catch (err) {
    log('error', 'lead_ingest_error', { error: err.message });
    res.status(500).json({ error: 'Failed to save lead.' });
  }
});

// PATCH /api/agent/:id/leads/:leadId — Update a lead
app.patch('/api/agent/:id/leads/:leadId', auth, (req, res) => {
  try {
    if (req.params.id !== req.agentId) return res.status(403).json({ error: 'Access denied' });

    const leads = loadLeads(req.params.id);
    const idx = leads.findIndex(l => l.id === req.params.leadId);
    if (idx === -1) return res.status(404).json({ error: 'Lead not found' });

    const allowed = ['name', 'phone', 'email', 'status', 'notes'];
    const validStatuses = ['new', 'contacted', 'qualified', 'won', 'lost'];

    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        if (key === 'status' && !validStatuses.includes(req.body[key])) {
          return res.status(400).json({ error: `Invalid status. Use: ${validStatuses.join(', ')}` });
        }
        leads[idx][key] = (req.body[key] || '').trim();
      }
    }
    leads[idx].updatedAt = new Date().toISOString();

    saveLeads(req.params.id, leads);
    res.json({ success: true, lead: leads[idx] });
  } catch (err) {
    log('error', 'lead_update_error', { error: err.message });
    res.status(500).json({ error: 'Failed to update lead.' });
  }
});

// DELETE /api/agent/:id/leads/:leadId — Delete a lead
app.delete('/api/agent/:id/leads/:leadId', auth, (req, res) => {
  try {
    if (req.params.id !== req.agentId) return res.status(403).json({ error: 'Access denied' });

    const leads = loadLeads(req.params.id);
    const idx = leads.findIndex(l => l.id === req.params.leadId);
    if (idx === -1) return res.status(404).json({ error: 'Lead not found' });

    leads.splice(idx, 1);
    saveLeads(req.params.id, leads);
    res.json({ success: true });
  } catch (err) {
    log('error', 'lead_delete_error', { error: err.message });
    res.status(500).json({ error: 'Failed to delete lead.' });
  }
});

// GET /api/agent/:id/leads/export — CSV export
app.get('/api/agent/:id/leads/export', auth, (req, res) => {
  try {
    if (req.params.id !== req.agentId) return res.status(403).json({ error: 'Access denied' });

    const leads = loadLeads(req.params.id);
    leads.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const escape = (v) => `"${(v || '').replace(/"/g, '""')}"`;
    const header = 'Name,Phone,Email,Status,Notes,Source,Created';
    const rows = leads.map(l =>
      [l.name, l.phone, l.email, l.status, l.notes, l.source, l.createdAt].map(escape).join(',')
    );

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="leads-${req.params.id}.csv"`);
    res.send([header, ...rows].join('\n'));
  } catch (err) {
    log('error', 'leads_export_error', { error: err.message });
    res.status(500).json({ error: 'Failed to export leads.' });
  }
});

// ============================================================
// BOOKINGS ENDPOINTS
// ============================================================

const BOOKINGS_DIR = path.join(__dirname, 'data', 'bookings');
if (!fs.existsSync(BOOKINGS_DIR)) fs.mkdirSync(BOOKINGS_DIR, { recursive: true });

function getAvailabilityPath(agentId) {
  return path.join(BOOKINGS_DIR, `${agentId}-availability.json`);
}
function getBookingsPath(agentId) {
  return path.join(BOOKINGS_DIR, `${agentId}-bookings.json`);
}

function loadAvailability(agentId) {
  const p = getAvailabilityPath(agentId);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}
function saveAvailability(agentId, data) {
  fs.writeFileSync(getAvailabilityPath(agentId), JSON.stringify(data, null, 2));
}
function loadBookings(agentId) {
  const p = getBookingsPath(agentId);
  if (!fs.existsSync(p)) return [];
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return []; }
}
function saveBookings(agentId, bookings) {
  fs.writeFileSync(getBookingsPath(agentId), JSON.stringify(bookings, null, 2));
}

// GET /api/agent/:id/availability — Get availability settings
app.get('/api/agent/:id/availability', auth, (req, res) => {
  try {
    if (req.params.id !== req.agentId) return res.status(403).json({ error: 'Access denied' });

    const avail = loadAvailability(req.params.id);
    if (!avail) {
      return res.json({
        schedule: {
          monday:    { enabled: false, start: '09:00', end: '17:00' },
          tuesday:   { enabled: false, start: '09:00', end: '17:00' },
          wednesday: { enabled: false, start: '09:00', end: '17:00' },
          thursday:  { enabled: false, start: '09:00', end: '17:00' },
          friday:    { enabled: false, start: '09:00', end: '17:00' },
          saturday:  { enabled: false, start: '09:00', end: '17:00' },
          sunday:    { enabled: false, start: '09:00', end: '17:00' },
        },
        appointmentTypes: [],
        bufferMinutes: 15,
        blockedDates: [],
        googleCalendar: { connected: false },
        updatedAt: null,
      });
    }
    res.json(avail);
  } catch (err) {
    log('error', 'availability_get_error', { error: err.message });
    res.status(500).json({ error: 'Failed to load availability.' });
  }
});

// PUT /api/agent/:id/availability — Update availability settings
app.put('/api/agent/:id/availability', auth, (req, res) => {
  try {
    if (req.params.id !== req.agentId) return res.status(403).json({ error: 'Access denied' });

    const { schedule, appointmentTypes, bufferMinutes, blockedDates } = req.body;

    const validDays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    if (schedule) {
      for (const day of validDays) {
        if (schedule[day]) {
          const d = schedule[day];
          if (typeof d.enabled !== 'boolean') {
            return res.status(400).json({ error: `Invalid schedule for ${day}` });
          }
        }
      }
    }

    if (appointmentTypes && Array.isArray(appointmentTypes)) {
      for (const t of appointmentTypes) {
        if (!t.name || !t.durationMinutes || t.durationMinutes < 5 || t.durationMinutes > 480) {
          return res.status(400).json({ error: 'Each appointment type needs a name and duration (5-480 minutes)' });
        }
      }
    }

    const existing = loadAvailability(req.params.id) || {};
    const updated = {
      schedule: schedule || existing.schedule || {},
      appointmentTypes: appointmentTypes || existing.appointmentTypes || [],
      bufferMinutes: typeof bufferMinutes === 'number' ? bufferMinutes : (existing.bufferMinutes || 15),
      blockedDates: blockedDates || existing.blockedDates || [],
      googleCalendar: existing.googleCalendar || { connected: false },
      updatedAt: new Date().toISOString(),
    };

    saveAvailability(req.params.id, updated);
    res.json({ success: true, availability: updated });
  } catch (err) {
    log('error', 'availability_update_error', { error: err.message });
    res.status(500).json({ error: 'Failed to save availability.' });
  }
});

// GET /api/agent/:id/bookings — List bookings
app.get('/api/agent/:id/bookings', auth, (req, res) => {
  try {
    if (req.params.id !== req.agentId) return res.status(403).json({ error: 'Access denied' });

    let bookings = loadBookings(req.params.id);

    if (req.query.status) {
      bookings = bookings.filter(b => b.status === req.query.status);
    }
    if (req.query.from) {
      bookings = bookings.filter(b => b.startTime >= req.query.from);
    }
    if (req.query.to) {
      bookings = bookings.filter(b => b.startTime <= req.query.to);
    }

    bookings.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));

    const all = loadBookings(req.params.id);
    const now = new Date().toISOString();
    const today = now.slice(0, 10);
    const stats = {
      total: all.length,
      upcoming: all.filter(b => b.startTime >= now && b.status === 'confirmed').length,
      today: all.filter(b => (b.startTime || '').slice(0, 10) === today && b.status === 'confirmed').length,
      cancelled: all.filter(b => b.status === 'cancelled').length,
    };

    res.json({ bookings, stats });
  } catch (err) {
    log('error', 'bookings_list_error', { error: err.message });
    res.status(500).json({ error: 'Failed to load bookings.' });
  }
});

// POST /api/agent/:id/bookings — Create a booking (from dashboard or AI)
app.post('/api/agent/:id/bookings', auth, (req, res) => {
  try {
    if (req.params.id !== req.agentId) return res.status(403).json({ error: 'Access denied' });

    const { customerName, customerPhone, customerEmail, appointmentType, startTime, notes } = req.body;
    if (!customerName && !customerPhone) return res.status(400).json({ error: 'Customer name or phone is required.' });
    if (!startTime) return res.status(400).json({ error: 'Start time is required.' });

    const avail = loadAvailability(req.params.id);
    let durationMinutes = 60;
    if (avail && appointmentType) {
      const type = avail.appointmentTypes.find(t => t.name === appointmentType);
      if (type) durationMinutes = type.durationMinutes;
    }

    const start = new Date(startTime);
    const end = new Date(start.getTime() + durationMinutes * 60000);

    const existing = loadBookings(req.params.id);
    const conflict = existing.find(b => {
      if (b.status === 'cancelled') return false;
      return start < new Date(b.endTime) && end > new Date(b.startTime);
    });
    if (conflict) return res.status(409).json({ error: 'This time slot conflicts with an existing booking.' });

    const booking = {
      id: crypto.randomBytes(8).toString('hex'),
      customerName: (customerName || '').trim(),
      customerPhone: (customerPhone || '').trim(),
      customerEmail: (customerEmail || '').trim(),
      appointmentType: (appointmentType || '').trim(),
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      durationMinutes,
      status: 'confirmed',
      notes: (notes || '').trim(),
      source: 'dashboard',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    existing.push(booking);
    saveBookings(req.params.id, existing);
    res.json({ success: true, booking });
  } catch (err) {
    log('error', 'booking_create_error', { error: err.message });
    res.status(500).json({ error: 'Failed to create booking.' });
  }
});

// POST /api/agent/:id/bookings/ingest — Unauthenticated booking creation (called by OpenClaw bot)
app.post('/api/agent/:id/bookings/ingest', (req, res) => {
  try {
    const agentId = req.params.id;
    const agent = getAgent(agentId);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const ingestToken = req.headers['x-ingest-token'] || '';
    if (!agent.ingestToken || ingestToken !== agent.ingestToken) {
      return res.status(401).json({ error: 'Invalid ingest token' });
    }

    const { customerName, customerPhone, appointmentType, startTime, notes } = req.body;
    if (!startTime) return res.status(400).json({ error: 'Start time is required.' });

    const avail = loadAvailability(agentId);
    let durationMinutes = 60;
    if (avail && appointmentType) {
      const type = avail.appointmentTypes.find(t => t.name === appointmentType);
      if (type) durationMinutes = type.durationMinutes;
    }

    const start = new Date(startTime);
    const end = new Date(start.getTime() + durationMinutes * 60000);

    const existing = loadBookings(agentId);
    const conflict = existing.find(b => {
      if (b.status === 'cancelled') return false;
      return start < new Date(b.endTime) && end > new Date(b.startTime);
    });
    if (conflict) return res.status(409).json({ error: 'This time slot is no longer available.' });

    const booking = {
      id: crypto.randomBytes(8).toString('hex'),
      customerName: (customerName || '').trim(),
      customerPhone: (customerPhone || '').trim(),
      customerEmail: '',
      appointmentType: (appointmentType || '').trim(),
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      durationMinutes,
      status: 'confirmed',
      notes: (notes || '').trim(),
      source: 'whatsapp-ai',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    existing.push(booking);
    saveBookings(agentId, existing);
    res.json({ success: true, booking });
  } catch (err) {
    log('error', 'booking_ingest_error', { error: err.message });
    res.status(500).json({ error: 'Failed to save booking.' });
  }
});

// PATCH /api/agent/:id/bookings/:bookingId — Update a booking (reschedule/cancel)
app.patch('/api/agent/:id/bookings/:bookingId', auth, (req, res) => {
  try {
    if (req.params.id !== req.agentId) return res.status(403).json({ error: 'Access denied' });

    const bookings = loadBookings(req.params.id);
    const idx = bookings.findIndex(b => b.id === req.params.bookingId);
    if (idx === -1) return res.status(404).json({ error: 'Booking not found' });

    const allowed = ['customerName', 'customerPhone', 'customerEmail', 'appointmentType', 'startTime', 'status', 'notes'];
    const validStatuses = ['confirmed', 'cancelled', 'completed', 'no-show'];

    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        if (key === 'status' && !validStatuses.includes(req.body[key])) {
          return res.status(400).json({ error: `Invalid status. Use: ${validStatuses.join(', ')}` });
        }
        bookings[idx][key] = typeof req.body[key] === 'string' ? req.body[key].trim() : req.body[key];
      }
    }

    if (req.body.startTime) {
      const start = new Date(req.body.startTime);
      const dur = bookings[idx].durationMinutes || 60;
      bookings[idx].startTime = start.toISOString();
      bookings[idx].endTime = new Date(start.getTime() + dur * 60000).toISOString();

      const conflict = bookings.find((b, i) => {
        if (i === idx || b.status === 'cancelled') return false;
        return start < new Date(b.endTime) && new Date(bookings[idx].endTime) > new Date(b.startTime);
      });
      if (conflict) return res.status(409).json({ error: 'This time slot conflicts with another booking.' });
    }

    bookings[idx].updatedAt = new Date().toISOString();
    saveBookings(req.params.id, bookings);
    res.json({ success: true, booking: bookings[idx] });
  } catch (err) {
    log('error', 'booking_update_error', { error: err.message });
    res.status(500).json({ error: 'Failed to update booking.' });
  }
});

// DELETE /api/agent/:id/bookings/:bookingId — Delete a booking
app.delete('/api/agent/:id/bookings/:bookingId', auth, (req, res) => {
  try {
    if (req.params.id !== req.agentId) return res.status(403).json({ error: 'Access denied' });

    const bookings = loadBookings(req.params.id);
    const idx = bookings.findIndex(b => b.id === req.params.bookingId);
    if (idx === -1) return res.status(404).json({ error: 'Booking not found' });

    bookings.splice(idx, 1);
    saveBookings(req.params.id, bookings);
    res.json({ success: true });
  } catch (err) {
    log('error', 'booking_delete_error', { error: err.message });
    res.status(500).json({ error: 'Failed to delete booking.' });
  }
});

// GET /api/agent/:id/bookings/slots — Get available slots for a date
app.get('/api/agent/:id/bookings/slots', auth, (req, res) => {
  try {
    if (req.params.id !== req.agentId) return res.status(403).json({ error: 'Access denied' });

    const { date, type } = req.query;
    if (!date) return res.status(400).json({ error: 'Date parameter required (YYYY-MM-DD)' });

    const avail = loadAvailability(req.params.id);
    if (!avail) return res.json({ slots: [], message: 'No availability configured' });

    if (avail.blockedDates && avail.blockedDates.includes(date)) {
      return res.json({ slots: [], message: 'This date is blocked' });
    }

    const dayOfWeek = new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
    const daySchedule = avail.schedule[dayOfWeek];
    if (!daySchedule || !daySchedule.enabled) {
      return res.json({ slots: [], message: 'Not available on this day' });
    }

    let durationMinutes = 60;
    if (type && avail.appointmentTypes.length > 0) {
      const apptType = avail.appointmentTypes.find(t => t.name === type);
      if (apptType) durationMinutes = apptType.durationMinutes;
    } else if (avail.appointmentTypes.length > 0) {
      durationMinutes = avail.appointmentTypes[0].durationMinutes;
    }

    const buffer = avail.bufferMinutes || 0;
    const [startH, startM] = daySchedule.start.split(':').map(Number);
    const [endH, endM] = daySchedule.end.split(':').map(Number);
    const dayStartMin = startH * 60 + startM;
    const dayEndMin = endH * 60 + endM;

    const bookings = loadBookings(req.params.id).filter(b => {
      if (b.status === 'cancelled') return false;
      return (b.startTime || '').slice(0, 10) === date;
    });

    const slots = [];
    let cursor = dayStartMin;
    while (cursor + durationMinutes <= dayEndMin) {
      const slotStart = new Date(`${date}T${String(Math.floor(cursor / 60)).padStart(2, '0')}:${String(cursor % 60).padStart(2, '0')}:00`);
      const slotEnd = new Date(slotStart.getTime() + durationMinutes * 60000);

      const hasConflict = bookings.some(b => {
        return slotStart < new Date(b.endTime) && slotEnd > new Date(b.startTime);
      });

      if (!hasConflict) {
        slots.push({
          start: slotStart.toISOString(),
          end: slotEnd.toISOString(),
          label: `${String(Math.floor(cursor / 60)).padStart(2, '0')}:${String(cursor % 60).padStart(2, '0')}`,
        });
      }

      cursor += durationMinutes + buffer;
    }

    res.json({ slots, date, durationMinutes });
  } catch (err) {
    log('error', 'slots_error', { error: err.message });
    res.status(500).json({ error: 'Failed to generate available slots.' });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Global error handler — prevents stack traces leaking to clients
app.use((err, req, res, next) => {
  log('error', 'unhandled_error', { error: err.message, path: req.path });
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Automatyn SaaS API running on port ${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
});
