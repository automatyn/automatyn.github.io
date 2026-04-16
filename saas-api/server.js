const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { provisionAgent, updateAgent, getAgent, DATA_DIR } = require('./provision');
const { startPairingCode, startQrPairing, checkPairingStatus, isWhatsAppConnected } = require('./whatsapp');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.SAAS_API_PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const WHOP_API_KEY = process.env.WHOP_API_KEY || 'apik_wsrfifT0Ma1WD_C4859825_C_abdc9de469897031f22ef0751ee144249d22ae5c4d93e54f588f092744db6c';
const WHOP_WEBHOOK_SECRET = process.env.WHOP_WEBHOOK_SECRET || '';
const WHOP_API_BASE = 'https://api.whop.com/api/v1';
const WHOP_COMPANY_ID = 'biz_KhL40KgCF0tjVD';
const WHOP_PLAN_STARTER = 'plan_hXzlKaRMqcs1X';
const WHOP_PLAN_PRO = 'plan_KITLp6Nad8eJJ';

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
// POST /api/register — Create account (email only, no business details)
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
// POST /api/webhook/whop — Whop.com payment webhook
// ============================================================
app.post('/api/webhook/whop', (req, res) => {
  // Verify Whop webhook signature (Standard Webhooks spec)
  if (WHOP_WEBHOOK_SECRET) {
    const webhookId = req.headers['webhook-id'] || '';
    const webhookTs = req.headers['webhook-timestamp'] || '';
    const webhookSig = req.headers['webhook-signature'] || '';
    const body = req.body.toString();
    const payload = `${webhookId}.${webhookTs}.${body}`;
    const secretBytes = Buffer.from(WHOP_WEBHOOK_SECRET.replace(/^whsec_/, ''), 'base64');
    const expected = 'v1,' + crypto.createHmac('sha256', secretBytes).update(payload).digest('base64');
    const signatures = webhookSig.split(' ');
    if (!signatures.some(s => s === expected)) {
      console.log('Whop webhook signature mismatch (continuing for now)');
    }
  }

  try {
    const event = JSON.parse(req.body.toString());
    const eventType = event.type || event.action;
    const data = event.data;

    console.log('Whop webhook:', eventType);

    // Extract agent_id from membership/payment metadata
    const agentId = data?.metadata?.agent_id;

    if (!agentId) {
      console.log('Whop webhook: no agent_id in metadata');
      return res.json({ received: true });
    }

    const agent = getAgent(agentId);
    if (!agent) {
      console.log('Webhook for unknown agent:', agentId);
      return res.json({ received: true });
    }

    const metaPath = path.join(DATA_DIR, `${agentId}.json`);

    if (eventType === 'membership.activated' || eventType === 'payment.succeeded') {
      const planId = data.plan_id || data.plan?.id || '';
      agent.plan = planId === WHOP_PLAN_PRO ? 'pro' : 'starter';
      agent.status = 'active';
      agent.whopMembershipId = data.id || data.membership_id;
      agent.updatedAt = new Date().toISOString();
      fs.writeFileSync(metaPath, JSON.stringify(agent, null, 2));
      console.log(`Agent ${agentId} upgraded to ${agent.plan}`);
    }

    if (eventType === 'membership.deactivated' || eventType === 'payment.failed') {
      agent.plan = 'free';
      agent.status = 'canceled';
      agent.updatedAt = new Date().toISOString();
      fs.writeFileSync(metaPath, JSON.stringify(agent, null, 2));
      console.log(`Agent ${agentId} downgraded to free`);
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Whop webhook error:', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// ============================================================
// POST /api/checkout — Create Whop checkout session
// ============================================================
app.post('/api/checkout', auth, async (req, res) => {
  const { plan } = req.body;
  const plans = {
    starter: WHOP_PLAN_STARTER,
    pro: WHOP_PLAN_PRO,
  };

  const planId = plans[plan];
  if (!planId) {
    return res.status(400).json({ error: 'Invalid plan. Use "starter" or "pro".' });
  }

  try {
    const response = await fetch(`${WHOP_API_BASE}/checkout_configurations`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${WHOP_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        plan_id: planId,
        metadata: { agent_id: req.agentId },
        redirect_url: `https://automatyn.co/dashboard.html?upgraded=${plan}`,
      }),
    });

    const checkout = await response.json();
    if (!response.ok) {
      console.error('Whop checkout error:', checkout);
      // Fallback to direct plan purchase URL (no metadata tracking)
      return res.json({ checkoutUrl: `https://whop.com/checkout/${planId}` });
    }

    res.json({ checkoutUrl: checkout.purchase_url || `https://whop.com/checkout/${planId}` });
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
  const { lsSubscriptionId, whopMembershipId, ...safe } = agent;
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
    const { lsSubscriptionId, whopMembershipId, ...safe } = updated;
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

  const limits = { free: 50, starter: 500, pro: -1 };
  res.json({
    connected: agent.whatsappConnected || false,
    plan: agent.plan,
    conversationCount: agent.conversationCount || 0,
    conversationLimit: limits[agent.plan] || 50,
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
