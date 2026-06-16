// Microsoft Graph access via OAuth device-code flow.
//
// Device-code flow is ideal for a one-time, interactive script: you register a
// public client app in Azure, run the script, open the printed URL, sign in with
// YOUR Microsoft 365 account, and the script receives a delegated token scoped to
// your own mailbox (Mail.Read). No client secret is needed.

const path = require('path');
const fs = require('fs');

const LOGIN = 'https://login.microsoftonline.com';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const TOKEN_CACHE = path.join(__dirname, '..', '.ms-token.json');

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function loadRefreshToken() {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_CACHE, 'utf8')).refresh_token || null;
  } catch {
    return null;
  }
}

function saveRefreshToken(tok) {
  if (!tok || !tok.refresh_token) return;
  try {
    fs.writeFileSync(TOKEN_CACHE, JSON.stringify({ refresh_token: tok.refresh_token }), { mode: 0o600 });
  } catch { /* best-effort */ }
}

// Exchange a cached refresh token for a new access token (no interaction).
async function refreshAccessToken(tenant, clientId, scope) {
  const refresh = loadRefreshToken();
  if (!refresh) return null;
  const res = await fetch(`${LOGIN}/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      scope,
      refresh_token: refresh,
    }),
  });
  if (!res.ok) return null;
  const tok = await res.json();
  if (!tok.access_token) return null;
  saveRefreshToken(tok);
  return tok.access_token;
}

// Step 1: reuse a cached login if possible, else run the device-code flow.
async function getAccessToken({ scopes = ['Mail.Read', 'offline_access'] } = {}) {
  const tenant = process.env.MS_TENANT_ID || 'common';
  const clientId = required('MS_CLIENT_ID');
  const scope = scopes.join(' ');

  const reused = await refreshAccessToken(tenant, clientId, scope);
  if (reused) {
    console.log('Reused saved Microsoft 365 session.\n');
    return reused;
  }

  const dcRes = await fetch(`${LOGIN}/${tenant}/oauth2/v2.0/devicecode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, scope }),
  });
  if (!dcRes.ok) {
    throw new Error(`Device code request failed (${dcRes.status}): ${await dcRes.text()}`);
  }
  const dc = await dcRes.json();

  console.log('\n=== Microsoft 365 sign-in required ===');
  console.log(dc.message || `Open ${dc.verification_uri} and enter code ${dc.user_code}`);
  console.log('Waiting for you to finish signing in...\n');

  const interval = (dc.interval || 5) * 1000;
  const deadline = Date.now() + (dc.expires_in || 900) * 1000;

  while (Date.now() < deadline) {
    await sleep(interval);
    const tokRes = await fetch(`${LOGIN}/${tenant}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: clientId,
        device_code: dc.device_code,
      }),
    });
    const tok = await tokRes.json();
    if (tokRes.ok && tok.access_token) {
      console.log('Signed in to Microsoft 365.\n');
      saveRefreshToken(tok);
      return tok.access_token;
    }
    if (tok.error === 'authorization_pending') continue;
    if (tok.error === 'slow_down') { await sleep(interval); continue; }
    throw new Error(`Sign-in failed: ${tok.error} - ${tok.error_description || ''}`);
  }
  throw new Error('Sign-in timed out. Run the script again.');
}

// Step 2: page through messages received FROM a given sender address.
// Returns [{ id, subject, receivedDateTime, from, bodyText }].
async function fetchMessagesFromSender(accessToken, senderEmail, { max = 5000 } = {}) {
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' };
  // NOTE: Graph rejects $filter on `from` combined with $orderby on a different
  // field ("InefficientFilter"), so we filter only and sort client-side later.
  const params = new URLSearchParams({
    $filter: `from/emailAddress/address eq '${senderEmail}'`,
    $select: 'id,subject,receivedDateTime,from,body,bodyPreview',
    $top: '50',
  });
  let url = `${GRAPH}/me/messages?${params.toString()}`;
  const out = [];

  while (url && out.length < max) {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      throw new Error(`Graph messages failed (${res.status}): ${(await res.text()).slice(0, 400)}`);
    }
    const data = await res.json();
    for (const m of data.value || []) {
      out.push({
        id: m.id,
        subject: m.subject || '',
        receivedDateTime: m.receivedDateTime,
        from: m.from && m.from.emailAddress ? m.from.emailAddress.address : '',
        bodyText: htmlToText(m.body && m.body.content, m.body && m.body.contentType),
      });
    }
    url = data['@odata.nextLink'] || null;
  }
  return out;
}

// Minimal HTML -> text: drop scripts/styles, convert breaks, strip tags, decode
// the handful of entities that actually matter for emails/phones/names.
function htmlToText(content, contentType) {
  if (!content) return '';
  if ((contentType || '').toLowerCase() !== 'html') return String(content);
  return String(content)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<br\s*\/?>(?=)/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

module.exports = { getAccessToken, fetchMessagesFromSender, htmlToText };
