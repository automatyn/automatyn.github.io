const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const OPENCLAW_HOME = path.join(require('os').homedir(), '.openclaw');
const OPENCLAW_CONFIG = path.join(OPENCLAW_HOME, 'openclaw.json');
const AGENTS_DIR = path.join(OPENCLAW_HOME, 'agents');
const DATA_DIR = path.join(__dirname, 'data');
const TEMPLATE_PATH = path.join(__dirname, 'soul-template.md');

// Simple in-memory mutex to prevent concurrent openclaw.json writes
let _configLock = Promise.resolve();
function withConfigLock(fn) {
  const prev = _configLock;
  let release;
  _configLock = new Promise(r => { release = r; });
  return prev.then(fn).finally(release);
}

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function generateAgentId(businessName) {
  const slug = (businessName || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30);
  const suffix = crypto.randomBytes(3).toString('hex');
  return slug ? `biz-${slug}-${suffix}` : `biz-${suffix}`;
}

function renderTemplate(template, data) {
  let result = template;

  // Handle conditional sections: {{#key}}...{{/key}}
  result = result.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (match, key, content) => {
    return data[key] ? content.replace(/\{\{(\w+)\}\}/g, (m, k) => data[k] || '') : '';
  });

  // Handle simple replacements: {{key}}
  result = result.replace(/\{\{(\w+)\}\}/g, (match, key) => data[key] || '');

  return result;
}

function getWorkflowArchetype(industry) {
  const key = (industry || '').toLowerCase();

  const quoteIndustries = ['plumb', 'electric', 'auto', 'mechanic', 'hvac', 'roof', 'locksmith', 'handyman', 'pest', 'landscap', 'clean', 'moving', 'car wash'];
  const consultationIndustries = ['legal', 'account', 'lawyer', 'real estate', 'photograph', 'event', 'cater', 'wedding', 'insurance', 'tattoo', 'architect'];
  const reservationIndustries = ['restaurant', 'café', 'cafe', 'bakery'];

  if (quoteIndustries.some(q => key.includes(q))) return 'quote';
  if (consultationIndustries.some(q => key.includes(q))) return 'consultation';
  if (reservationIndustries.some(q => key.includes(q))) return 'reservation';
  return 'booking'; // default: appointment-based (salon, barber, dentist, PT, tutor, etc.)
}

function generateSoulMd(agentData) {
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf-8');
  const archetype = getWorkflowArchetype(agentData.industry);
  return renderTemplate(template, {
    businessName: agentData.businessName,
    industry: agentData.industry,
    location: agentData.location || '',
    services: agentData.services,
    prices: agentData.prices,
    hours: agentData.hours,
    policies: agentData.policies || '',
    isFreeTier: agentData.plan === 'free' ? 'true' : '',
    isBooking: archetype === 'booking' ? 'true' : '',
    isQuote: archetype === 'quote' ? 'true' : '',
    isConsultation: archetype === 'consultation' ? 'true' : '',
    isReservation: archetype === 'reservation' ? 'true' : '',
  });
}

function provisionAgent(agentData) {
  const agentId = agentData.agentId || generateAgentId(agentData.businessName);
  const workspaceDir = path.join(AGENTS_DIR, agentId);

  // Create workspace directory
  fs.mkdirSync(workspaceDir, { recursive: true });

  const agentDir = path.join(workspaceDir, 'agent');
  fs.mkdirSync(agentDir, { recursive: true });

  // Only set up the full agent if business details are provided
  if (agentData.businessName) {
    // Write SOUL.md
    const soulContent = generateSoulMd(agentData);
    fs.writeFileSync(path.join(workspaceDir, 'SOUL.md'), soulContent);

    // Write auth profile (use the default Google API key)
    const authProfile = {
      version: 1,
      profiles: {
        'google:default': {
          type: 'api_key',
          provider: 'google',
          key: process.env.GEMINI_API_KEY || '',
        },
        'openai:manual': {
          type: 'api_key',
          provider: 'openai',
          key: process.env.OPENAI_API_KEY || '',
        },
      },
      usageStats: {},
    };
    fs.writeFileSync(
      path.join(agentDir, 'auth-profiles.json'),
      JSON.stringify(authProfile, null, 2)
    );

    // Add agent directly to openclaw.json (bypasses CLI SHA race condition with gateway)
    registerAgentInConfig(agentId, agentData.businessName, agentData.industry, workspaceDir, agentDir);
  }

  // Save agent metadata
  const metadata = {
    agentId,
    email: agentData.email,
    businessName: agentData.businessName,
    industry: agentData.industry,
    services: agentData.services,
    prices: agentData.prices,
    hours: agentData.hours,
    location: agentData.location || '',
    policies: agentData.policies || '',
    plan: agentData.plan || 'free',
    status: 'provisioned',
    ingestToken: crypto.randomBytes(16).toString('hex'),
    whatsappConnected: false,
    conversationCount: 0,
    conversationResetDate: getNextMonthReset(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(
    path.join(DATA_DIR, `${agentId}.json`),
    JSON.stringify(metadata, null, 2)
  );

  return metadata;
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(OPENCLAW_CONFIG, 'utf-8'));
  } catch (err) {
    // If config doesn't exist or is corrupted, create a valid default
    console.error('openclaw.json missing or corrupted, creating default:', err.message);
    const defaultConfig = {
      meta: { version: 1, lastTouchedAt: new Date().toISOString() },
      agents: { list: [] },
      channels: { whatsapp: { enabled: true, accounts: {} } },
    };
    fs.mkdirSync(path.dirname(OPENCLAW_CONFIG), { recursive: true });
    fs.writeFileSync(OPENCLAW_CONFIG, JSON.stringify(defaultConfig, null, 2));
    return defaultConfig;
  }
}

function saveConfig(config) {
  // Atomic write: write to temp file then rename
  const tmpPath = OPENCLAW_CONFIG + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2));
  fs.renameSync(tmpPath, OPENCLAW_CONFIG);
}

function reloadGateway() {
  try {
    execSync('node /usr/lib/node_modules/openclaw/openclaw.mjs gateway reload', { timeout: 10000, stdio: 'pipe' });
    return true;
  } catch (err) {
    console.error('Gateway reload failed:', err.message);
    return false;
  }
}

function registerAgentInConfig(agentId, businessName, industry, workspaceDir, agentDir) {
  return withConfigLock(() => {
    const config = loadConfig();
    if (!config.agents) config.agents = { list: [] };
    if (!config.agents.list) config.agents.list = [];
    const alreadyExists = config.agents.list.some(a => a.id === agentId);
    if (!alreadyExists) {
      const emoji = getIndustryEmoji(industry);
      config.agents.list.push({
        id: agentId,
        name: businessName,
        workspace: workspaceDir,
        agentDir: agentDir,
        model: 'google/gemini-2.5-flash',
        identity: { name: businessName, emoji },
        humanDelay: {
          mode: 'natural',
          minMs: 1500,
          maxMs: 4000,
        },
      });
      config.meta.lastTouchedAt = new Date().toISOString();
      saveConfig(config);
      reloadGateway();
    }
  });
}

function updateAgent(agentId, updates) {
  const metaPath = path.join(DATA_DIR, `${agentId}.json`);
  if (!fs.existsSync(metaPath)) {
    throw new Error('Agent not found');
  }

  const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  const updatable = ['businessName', 'industry', 'services', 'prices', 'hours', 'location', 'policies'];

  for (const key of updatable) {
    if (updates[key] !== undefined) {
      metadata[key] = updates[key];
    }
  }
  metadata.updatedAt = new Date().toISOString();

  const workspaceDir = path.join(AGENTS_DIR, agentId);
  const agentDir = path.join(workspaceDir, 'agent');

  // If business name is being set for the first time (onboarding), register with OpenClaw
  if (metadata.businessName && !fs.existsSync(path.join(workspaceDir, 'SOUL.md'))) {
    fs.mkdirSync(agentDir, { recursive: true });

    // Write auth profile
    const authProfile = {
      version: 1,
      profiles: {
        'google:default': {
          type: 'api_key',
          provider: 'google',
          key: process.env.GEMINI_API_KEY || '',
        },
        'openai:manual': {
          type: 'api_key',
          provider: 'openai',
          key: process.env.OPENAI_API_KEY || '',
        },
      },
      usageStats: {},
    };
    fs.writeFileSync(
      path.join(agentDir, 'auth-profiles.json'),
      JSON.stringify(authProfile, null, 2)
    );

    registerAgentInConfig(agentId, metadata.businessName, metadata.industry, workspaceDir, agentDir);
  }

  // Regenerate SOUL.md (only if we have business details)
  if (metadata.businessName) {
    const soulContent = generateSoulMd(metadata);
    fs.writeFileSync(path.join(workspaceDir, 'SOUL.md'), soulContent);
  }

  // Save updated metadata
  fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2));

  return metadata;
}

function getAgent(agentId) {
  const metaPath = path.join(DATA_DIR, `${agentId}.json`);
  if (!fs.existsSync(metaPath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
}

function getIndustryEmoji(industry) {
  const map = {
    'salon': '💇',
    'barber': '💈',
    'restaurant': '🍽️',
    'cafe': '☕',
    'plumber': '🔧',
    'electrician': '⚡',
    'dentist': '🦷',
    'doctor': '🏥',
    'gym': '💪',
    'yoga': '🧘',
    'vet': '🐾',
    'dog groomer': '🐕',
    'photographer': '📸',
    'real estate': '🏠',
    'lawyer': '⚖️',
    'accountant': '📊',
    'tutor': '📚',
    'cleaner': '🧹',
    'landscaper': '🌿',
    'mechanic': '🔩',
    'tattoo': '🎨',
    'spa': '🧖',
    'bakery': '🍞',
    'florist': '💐',
    'other': '🤖',
  };
  const key = (industry || '').toLowerCase();
  for (const [k, v] of Object.entries(map)) {
    if (key.includes(k)) return v;
  }
  return '🤖';
}

function getNextMonthReset() {
  const now = new Date();
  return new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
}

module.exports = {
  provisionAgent,
  updateAgent,
  getAgent,
  generateAgentId,
  DATA_DIR,
  loadConfig,
  saveConfig,
  reloadGateway,
  withConfigLock,
  OPENCLAW_CONFIG,
};
