// Load env vars from /etc/automatyn-api.env for one-shot CLI scripts.
// systemd-managed services already get them via EnvironmentFile, so this is a no-op there.
// Existing process.env values win over the file (so inline overrides still work).

const fs = require('fs');

const ENV_FILE = '/etc/automatyn-api.env';

try {
  const raw = fs.readFileSync(ENV_FILE, 'utf8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
} catch (err) {
  if (err.code !== 'ENOENT' && err.code !== 'EACCES') throw err;
}
