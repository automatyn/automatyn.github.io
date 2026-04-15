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
const PADDLE_WEBHOOK_SECRET = process.env.PADDLE_WEBHOOK_SECRET || '';

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
// POST /api/webhook/paddle — Payment webhook
// ============================================================
app.post('/api/webhook/paddle', (req, res) => {
  // Verify Paddle signature (H1 scheme)
  if (PADDLE_WEBHOOK_SECRET) {
    const signature = req.headers['paddle-signature'] || '';
    const parts = Object.fromEntries(signature.split(';').map(p => p.split('=')));
    const ts = parts['ts'];
    const h1 = parts['h1'];
    if (!ts || !h1) {
      return res.status(401).json({ error: 'Invalid signature format' });
    }
    const payload = `${ts}:${req.body.toString()}`;
    const expected = crypto.createHmac('sha256', PADDLE_WEBHOOK_SECRET).update(payload).digest('hex');
    if (h1 !== expected) {
      return res.status(401).json({ error: 'Invalid signature' });
    }
  }

  try {
    const event = JSON.parse(req.body.toString());
    const eventType = event.event_type;
    const data = event.data;
    const agentId = data?.custom_data?.agent_id;

    console.log('Paddle webhook:', eventType, agentId || '(no agent_id)');

    if (!agentId) {
      return res.json({ received: true });
    }

    const agent = getAgent(agentId);
    if (!agent) {
      console.log('Webhook for unknown agent:', agentId);
      return res.json({ received: true });
    }

    const metaPath = path.join(DATA_DIR, `${agentId}.json`);
    const starterPriceId = 'pri_01kp9nmg87gyapxj153wv8t4y9';
    const proPriceId = 'pri_01kp9nmhq88fnny2ha7b37yxy2';

    if (eventType === 'subscription.created' || eventType === 'subscription.updated') {
      const priceId = data.items?.[0]?.price?.id || '';
      agent.plan = priceId === proPriceId ? 'pro' : 'starter';
      agent.status = 'active';
      agent.paddleSubscriptionId = data.id;
      agent.updatedAt = new Date().toISOString();
      fs.writeFileSync(metaPath, JSON.stringify(agent, null, 2));
    }

    if (eventType === 'subscription.canceled') {
      agent.plan = 'free';
      agent.updatedAt = new Date().toISOString();
      fs.writeFileSync(metaPath, JSON.stringify(agent, null, 2));
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: 'Webhook processing failed' });
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
  const { lsSubscriptionId, ...safe } = agent;
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
    const { lsSubscriptionId, ...safe } = updated;
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
