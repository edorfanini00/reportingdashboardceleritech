// Server-side Microsoft Graph access using a stored refresh token (no interactive
// login). Seed once via the MS_REFRESH_TOKEN env var; the rotated token is then
// persisted in Vercel KV so subsequent syncs keep working.
const { kv } = require('@vercel/kv');

const LOGIN = 'https://login.microsoftonline.com';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const KV_KEY = 'ms:refresh_token';

function kvAvailable() {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

async function getStoredRefreshToken() {
  if (kvAvailable()) {
    try {
      const t = await kv.get(KV_KEY);
      if (t) return t;
    } catch { /* fall through to env seed */ }
  }
  return process.env.MS_REFRESH_TOKEN || null;
}

async function saveRefreshToken(token) {
  if (token && kvAvailable()) {
    try { await kv.set(KV_KEY, token); } catch { /* best-effort */ }
  }
}

// Exchange the stored refresh token for an access token (and persist rotation).
async function getAccessToken() {
  const tenant = process.env.MS_TENANT_ID || 'common';
  const clientId = process.env.MS_CLIENT_ID;
  if (!clientId) throw new Error('MS_CLIENT_ID not set');
  const refresh = await getStoredRefreshToken();
  if (!refresh) throw new Error('No Microsoft refresh token. Seed MS_REFRESH_TOKEN in Vercel env.');

  const res = await fetch(`${LOGIN}/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      scope: 'Mail.Read offline_access',
      refresh_token: refresh,
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(`Microsoft token refresh failed: ${data.error || res.status} - ${data.error_description || ''}. Re-run the local login to refresh MS_REFRESH_TOKEN.`);
  }
  await saveRefreshToken(data.refresh_token);
  return data.access_token;
}

function htmlToText(content, contentType) {
  if (!content) return '';
  if ((contentType || '').toLowerCase() !== 'html') return String(content);
  return String(content)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<br\s*\/?>(?=)/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

async function fetchMessagesFromSender(accessToken, senderEmail, { max = 2000 } = {}) {
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' };
  const params = new URLSearchParams({
    $filter: `from/emailAddress/address eq '${senderEmail}'`,
    $select: 'id,subject,receivedDateTime,from,body,bodyPreview',
    $top: '50',
  });
  let url = `${GRAPH}/me/messages?${params.toString()}`;
  const out = [];
  while (url && out.length < max) {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Graph messages failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
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

module.exports = { getAccessToken, fetchMessagesFromSender, htmlToText };
