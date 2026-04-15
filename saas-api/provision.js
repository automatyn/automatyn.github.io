const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const OPENCLAW_HOME = path.join(require('os').homedir(), '.openclaw');
const AGENTS_DIR = path.join(OPENCLAW_HOME, 'agents');
const DATA_DIR = path.join(__dirname, 'data');
const TEMPLATE_PATH = path.join(__dirname, 'soul-template.md');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function generateAgentId(businessName) {
  const slug = businessName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30);
  const suffix = crypto.randomBytes(3).toString('hex');
  return `biz-${slug}-${suffix}`;
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

function generateSoulMd(agentData) {
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf-8');
  return renderTemplate(template, {
    businessName: agentData.businessName,
    industry: agentData.industry,
    location: agentData.location || '',
    services: agentData.services,
    prices: agentData.prices,
    hours: agentData.hours,
    policies: agentData.policies || '',
    isFreeTier: agentData.plan === 'free' ? 'true' : '',
  });
}

function provisionAgent(agentData) {
  const agentId = agentData.agentId || generateAgentId(agentData.businessName);
  const workspaceDir = path.join(AGENTS_DIR, agentId);

  // Create workspace directory
  fs.mkdirSync(workspaceDir, { recursive: true });

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
    },
    usageStats: {},
  };

  const agentDir = path.join(workspaceDir, 'agent');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, 'auth-profiles.json'),
    JSON.stringify(authProfile, null, 2)
  );

  // Add agent via OpenClaw CLI
  try {
    execSync(
      `openclaw agents add "${agentId}" --workspace "${workspaceDir}" --model google/gemini-2.5-flash --non-interactive --json`,
      { timeout: 15000, stdio: 'pipe' }
    );
  } catch (err) {
    // Agent might already exist if retrying
    const stderr = err.stderr ? err.stderr.toString() : '';
    if (!stderr.includes('already exists')) {
      throw new Error(`Failed to add agent: ${stderr}`);
    }
  }

  // Set identity
  const emoji = getIndustryEmoji(agentData.industry);
  try {
    execSync(
      `openclaw agents set-identity --agent "${agentId}" --name "${agentData.businessName.replace(/"/g, '\\"')}" --emoji "${emoji}"`,
      { timeout: 10000, stdio: 'pipe' }
    );
  } catch (err) {
    console.error('Warning: set-identity failed:', err.message);
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

  // Regenerate SOUL.md
  const workspaceDir = path.join(AGENTS_DIR, agentId);
  const soulContent = generateSoulMd(metadata);
  fs.writeFileSync(path.join(workspaceDir, 'SOUL.md'), soulContent);

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
  return new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString();
}

module.exports = {
  provisionAgent,
  updateAgent,
  getAgent,
  generateAgentId,
  DATA_DIR,
};
