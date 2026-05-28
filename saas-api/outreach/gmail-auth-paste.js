#!/usr/bin/env node
// Companion to gmail-auth.js for the headless / manual-paste flow.
// Usage: node gmail-auth-paste.js "<code-from-url-bar>"
// Exchanges the pasted auth code for tokens and writes gmail-token.json.
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const CLIENT_PATH = path.join(__dirname, '..', 'secrets', 'gmail-oauth-client.json');
const TOKEN_PATH = path.join(__dirname, '..', 'secrets', 'gmail-token.json');
const REDIRECT = 'http://localhost:8766/oauth2callback';

const code = process.argv[2];
if (!code) { console.error('Usage: node gmail-auth-paste.js "<code>"'); process.exit(1); }

const client = JSON.parse(fs.readFileSync(CLIENT_PATH, 'utf8')).installed;
const oauth2 = new google.auth.OAuth2(client.client_id, client.client_secret, REDIRECT);

(async () => {
  try {
    const { tokens } = await oauth2.getToken(decodeURIComponent(code));
    if (!tokens.refresh_token) {
      console.error('WARNING: no refresh_token in response. Re-run consent with prompt=consent (it was). If still missing, revoke prior grant at myaccount.google.com/permissions and retry.');
    }
    // Backup the old (dead) token first
    if (fs.existsSync(TOKEN_PATH)) {
      fs.copyFileSync(TOKEN_PATH, TOKEN_PATH + '.bak-dead');
    }
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
    fs.chmodSync(TOKEN_PATH, 0o600);
    console.log('OK token saved to', TOKEN_PATH);
    console.log('has_refresh_token:', !!tokens.refresh_token);
    console.log('scope:', tokens.scope);
    console.log('expiry:', tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : 'n/a');
  } catch (e) {
    console.error('EXCHANGE FAILED:', e.message);
    process.exit(1);
  }
})();
