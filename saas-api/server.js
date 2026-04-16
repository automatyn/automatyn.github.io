const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { provisionAgent, updateAgent, getAgent, DATA_DIR } = require('./provision');
const { startPairingCode, startQrPairing, checkPairingStatus, isWhatsAppConnected } = require('./whatsapp');
const authLib = require('./auth');
const fs = require('fs');
const path = require('path');

const APP_URL = process.env.APP_URL || 'https://automatyn.co';

const app = express();
const PORT = process.env.SAAS_API_PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const DODO_API_KEY = process.env.DODO_API_KEY;
const DODO_WEBHOOK_SECRET = process.env.DODO_WEBHOOK_SECRET;
const DODO_API_BASE = 'https://live.dodopayments.com';
const DODO_PRODUCT_STARTER = 'pdt_0NcooRMOGyOxO7roCiSmn';
const DODO_PRODUCT_PRO = 'pdt_0NcooSqClvpfz5UfxgLcS';

// Save JWT_SECRET to a file so it persists across restarts
const secretPath = path.join(__dirname, '.jwt-secret');
let jwtSecret = JWT_SECRET;
if (fs.existsSync(secretPath)) {
  jwtSecret = fs.readFileSync(secretPath, 'utf-8').trim();
} else {
  fs.writeFileSync(secretPath, jwtSecret);
}

app.use(cors({
  origin: ['https://automatyn.co', 'https://automatyn.github.io', 'http://localhost:8080'],
  methods: ['GET', 'POST', 'PUT'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Raw body for webhook signature verification
app.use('/api/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

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
  const plan = ['free', 'starter', 'pro'].includes(req.body.plan) ? req.body.plan : 'free';

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
    plan: user.plan || 'free',
  });
});

// POST /api/auth/magic-link — Send one-time sign-in link
// Creates account if email is new (no password required)
app.post('/api/auth/magic-link', async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  const email = (req.body.email || '').trim().toLowerCase();
  const plan = ['free', 'starter', 'pro'].includes(req.body.plan) ? req.body.plan : 'free';

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
  if (!user.verified) {
    user.verified = true;
    user.verifiedAt = new Date().toISOString();
  }
  user.lastLoginAt = new Date().toISOString();
  user.updatedAt = new Date().toISOString();
  authLib.setUser(entry.email, user);

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
    plan: user.plan || 'free',
    isNewUser: !!entry.isNewUser,
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

  user.verified = true;
  user.verifiedAt = new Date().toISOString();
  user.updatedAt = new Date().toISOString();
  authLib.setUser(entry.email, user);

  delete tokens[token];
  authLib.saveVerifyTokens(tokens);

  const jwtToken = issueJwt(user);
  res.json({
    success: true,
    token: jwtToken,
    agentId: user.agentId,
    email: user.email,
    verified: true,
    plan: user.plan || 'free',
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
    plan: user.plan || 'free',
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
    plan: user.plan || 'free',
  });
});

// ============================================================
// POST /api/register — Create account (email only, no business details) [LEGACY]
// ============================================================
app.post('/api/register', (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  if (!rateLimit(ip, 5, 3600000)) {
    return res.status(429).json({ error: 'Too many attempts. Try again in an hour.' });
  }

  const email = (req.body.email || '').trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  try {
    const plan = req.body.plan || 'free';
    const metadata = provisionAgent({
      email,
      businessName: '',
      industry: '',
      services: '',
      prices: '',
      hours: '',
      location: '',
      policies: '',
      plan,
    });

    const token = jwt.sign(
      { agentId: metadata.agentId, email },
      jwtSecret,
      { expiresIn: '365d' }
    );

    res.json({
      success: true,
      agentId: metadata.agentId,
      token,
      dashboardUrl: `https://automatyn.co/dashboard.html?agent=${metadata.agentId}&token=${token}&onboarding=true`,
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Failed to create account. Please try again.' });
  }
});

// ============================================================
// POST /api/signup — Create a new agent (legacy, full details)
// ============================================================
app.post('/api/signup', (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  if (!rateLimit(ip, 5, 3600000)) {
    return res.status(429).json({ error: 'Too many signups. Try again in an hour.' });
  }

  const error = validateSignup(req.body);
  if (error) {
    return res.status(400).json({ error });
  }

  try {
    const plan = req.body.plan || 'free';
    const metadata = provisionAgent({
      email: req.body.email.trim(),
      businessName: req.body.businessName.trim(),
      industry: req.body.industry.trim(),
      services: req.body.services.trim(),
      prices: (req.body.prices || '').trim(),
      hours: req.body.hours.trim(),
      location: (req.body.location || '').trim(),
      policies: (req.body.policies || '').trim(),
      plan,
    });

    const token = jwt.sign(
      { agentId: metadata.agentId, email: metadata.email },
      jwtSecret,
      { expiresIn: '365d' }
    );

    res.json({
      success: true,
      agentId: metadata.agentId,
      token,
      dashboardUrl: `https://automatyn.co/dashboard.html?agent=${metadata.agentId}&token=${token}`,
    });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Failed to create agent. Please try again.' });
  }
});

// ============================================================
// POST /api/webhook/dodo — DodoPayments webhook (Standard Webhooks spec)
// ============================================================
app.post('/api/webhook/dodo', (req, res) => {
  // Verify signature
  if (DODO_WEBHOOK_SECRET) {
    const webhookId = req.headers['webhook-id'] || '';
    const webhookTs = req.headers['webhook-timestamp'] || '';
    const webhookSig = req.headers['webhook-signature'] || '';
    const body = req.body.toString();
    const payload = `${webhookId}.${webhookTs}.${body}`;
    const secretBytes = Buffer.from(DODO_WEBHOOK_SECRET.replace(/^whsec_/, ''), 'base64');
    const expected = 'v1,' + crypto.createHmac('sha256', secretBytes).update(payload).digest('base64');
    const signatures = webhookSig.split(' ');
    if (!signatures.some(s => s === expected)) {
      console.log('Dodo webhook signature mismatch');
      return res.status(401).json({ error: 'Invalid signature' });
    }
  }

  try {
    const event = JSON.parse(req.body.toString());
    const eventType = event.type;
    const data = event.data;

    console.log('Dodo webhook:', eventType);

    const agentId = data?.metadata?.agent_id;

    if (!agentId) {
      console.log('Dodo webhook: no agent_id in metadata');
      return res.json({ received: true });
    }

    const agent = getAgent(agentId);
    if (!agent) {
      console.log('Webhook for unknown agent:', agentId);
      return res.json({ received: true });
    }

    const metaPath = path.join(DATA_DIR, `${agentId}.json`);

    if (eventType === 'subscription.active' || eventType === 'subscription.renewed' || eventType === 'payment.succeeded') {
      const productId = data.product_id || data.product?.product_id || '';
      agent.plan = productId === DODO_PRODUCT_PRO ? 'pro' : 'starter';
      agent.status = 'active';
      agent.dodoSubscriptionId = data.subscription_id || data.id;
      agent.updatedAt = new Date().toISOString();
      fs.writeFileSync(metaPath, JSON.stringify(agent, null, 2));
      console.log(`Agent ${agentId} upgraded to ${agent.plan}`);
    }

    if (eventType === 'subscription.cancelled' || eventType === 'subscription.expired' || eventType === 'subscription.failed') {
      agent.plan = 'free';
      agent.status = 'canceled';
      agent.updatedAt = new Date().toISOString();
      fs.writeFileSync(metaPath, JSON.stringify(agent, null, 2));
      console.log(`Agent ${agentId} downgraded to free`);
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Dodo webhook error:', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// ============================================================
// POST /api/checkout — Create DodoPayments subscription checkout
// ============================================================
app.post('/api/checkout', auth, async (req, res) => {
  const { plan } = req.body;
  const productIds = {
    starter: DODO_PRODUCT_STARTER,
    pro: DODO_PRODUCT_PRO,
  };

  const productId = productIds[plan];
  if (!productId) {
    return res.status(400).json({ error: 'Invalid plan. Use "starter" or "pro".' });
  }

  const agent = getAgent(req.agentId);
  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  try {
    const response = await fetch(`${DODO_API_BASE}/subscriptions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${DODO_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        product_id: productId,
        quantity: 1,
        payment_link: true,
        return_url: `https://automatyn.co/dashboard.html?upgraded=${plan}`,
        metadata: { agent_id: req.agentId },
        customer: {
          email: agent.email || req.email,
          name: agent.businessName || 'Automatyn Customer',
        },
        billing: {
          country: 'US',
          state: 'CA',
          city: 'San Francisco',
          street: '123 Main St',
          zipcode: '94102',
        },
      }),
    });

    const result = await response.json();
    if (!response.ok) {
      console.error('Dodo checkout error:', result);
      return res.status(500).json({ error: 'Failed to create checkout session' });
    }

    res.json({ checkoutUrl: result.payment_link });
  } catch (err) {
    console.error('Checkout error:', err);
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
  const { lsSubscriptionId, dodoSubscriptionId, ...safe } = agent;
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
    const { lsSubscriptionId, dodoSubscriptionId, ...safe } = updated;
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

  const limits = { free: 25, starter: 150, pro: -1 };
  res.json({
    connected: agent.whatsappConnected || false,
    plan: agent.plan,
    conversationCount: agent.conversationCount || 0,
    conversationLimit: limits[agent.plan] || 25,
    resetDate: agent.conversationResetDate,
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

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Automatyn SaaS API running on port ${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
});
