const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { provisionAgent, updateAgent, getAgent, DATA_DIR } = require('./provision');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.SAAS_API_PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const LS_WEBHOOK_SECRET = process.env.LEMONSQUEEZY_WEBHOOK_SECRET || '';

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
// POST /api/signup — Create a new agent
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
      dashboardUrl: `https://automatyn.co/saas/dashboard.html?agent=${metadata.agentId}&token=${token}`,
    });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Failed to create agent. Please try again.' });
  }
});

// ============================================================
// POST /api/webhook/lemonsqueezy — Payment webhook
// ============================================================
app.post('/api/webhook/lemonsqueezy', (req, res) => {
  // Verify signature
  if (LS_WEBHOOK_SECRET) {
    const signature = req.headers['x-signature'];
    const hmac = crypto.createHmac('sha256', LS_WEBHOOK_SECRET);
    hmac.update(req.body);
    const digest = hmac.digest('hex');
    if (signature !== digest) {
      return res.status(401).json({ error: 'Invalid signature' });
    }
  }

  try {
    const payload = JSON.parse(req.body.toString());
    const event = payload.meta?.event_name;
    const agentId = payload.meta?.custom_data?.agent_id;

    if (!agentId) {
      console.log('Webhook received without agent_id:', event);
      return res.json({ received: true });
    }

    const agent = getAgent(agentId);
    if (!agent) {
      console.log('Webhook for unknown agent:', agentId);
      return res.json({ received: true });
    }

    const metaPath = path.join(DATA_DIR, `${agentId}.json`);

    if (event === 'subscription_created' || event === 'subscription_updated') {
      const variantName = payload.data?.attributes?.variant_name || '';
      const plan = variantName.toLowerCase().includes('pro') ? 'pro' : 'starter';
      agent.plan = plan;
      agent.status = 'active';
      agent.lsSubscriptionId = payload.data?.id;
      agent.updatedAt = new Date().toISOString();
      fs.writeFileSync(metaPath, JSON.stringify(agent, null, 2));
    }

    if (event === 'subscription_cancelled' || event === 'subscription_expired') {
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

// ============================================================
// GET /api/agent/:id/qr — WhatsApp QR code
// ============================================================
app.get('/api/agent/:id/qr', auth, (req, res) => {
  if (req.params.id !== req.agentId) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const agent = getAgent(req.params.id);
  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  // WhatsApp QR code lives in the OpenClaw session directory
  // The exact path depends on OpenClaw's WhatsApp implementation
  // For now, return instructions for manual QR scanning
  const agentDir = path.join(require('os').homedir(), '.openclaw', 'agents', req.params.id);
  const sessionDir = path.join(agentDir, 'sessions');

  // Check for QR code file (OpenClaw stores these in session data)
  // This will need to be adjusted based on how OpenClaw exposes WhatsApp QR
  const qrPaths = [
    path.join(sessionDir, 'whatsapp-qr.png'),
    path.join(sessionDir, 'qr.png'),
    path.join(agentDir, 'whatsapp-qr.png'),
  ];

  for (const qrPath of qrPaths) {
    if (fs.existsSync(qrPath)) {
      return res.sendFile(qrPath);
    }
  }

  // If no QR code file found, the agent needs to be bound to WhatsApp first
  // and the gateway needs to generate a QR code
  res.json({
    status: 'pending',
    message: 'WhatsApp connection is being set up. The QR code will appear here shortly. If it does not appear within a few minutes, contact support.',
    instructions: [
      'Your WhatsApp bot is being configured.',
      'Once ready, a QR code will appear here.',
      'Scan it with your WhatsApp Business app to connect.',
    ],
  });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Automatyn SaaS API running on port ${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
});
