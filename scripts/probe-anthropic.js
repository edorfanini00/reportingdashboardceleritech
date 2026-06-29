// One-off latency probe for the Anthropic API. Not used by the app.
const fs = require('fs');
for (const line of fs.readFileSync(__dirname + '/../.env.probe', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { anthropicTools } = require('../api/_lib/agent-tools');

const KEY = process.env.ANTHROPIC_API_KEY;
const URL = 'https://api.anthropic.com/v1/messages';
const MODELS = ['claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-sonnet-4-6', 'claude-opus-4-8'];

async function timeCall(label, model, opts) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 40000);
  try {
    const res = await fetch(URL, {
      method: 'POST',
      headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(opts),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const ms = Date.now() - t0;
    const text = await res.text();
    let usage = '';
    try { const j = JSON.parse(text); usage = j.usage ? `in=${j.usage.input_tokens} out=${j.usage.output_tokens}` : ''; } catch {}
    console.log(`${label.padEnd(34)} ${model.padEnd(20)} ${String(ms + 'ms').padEnd(8)} status=${res.status} ${usage}${res.ok ? '' : ' BODY=' + text.slice(0, 160)}`);
  } catch (e) {
    clearTimeout(timer);
    console.log(`${label.padEnd(34)} ${model.padEnd(20)} ${String((Date.now() - t0) + 'ms').padEnd(8)} ${e.name === 'AbortError' ? 'TIMEOUT(40s)' : 'ERR ' + e.message}`);
  }
}

(async () => {
  console.log('== trivial: "hi", max_tokens=16, no tools ==');
  for (const m of MODELS) {
    await timeCall('trivial', m, { model: m, max_tokens: 16, messages: [{ role: 'user', content: 'Say hi in one word.' }] });
  }
  console.log('\n== app-like: max_tokens=4096 + full tool schema ==');
  const tools = anthropicTools();
  for (const m of MODELS) {
    await timeCall('app-like (tools+4096)', m, {
      model: m, max_tokens: 4096, tools,
      messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
    });
  }
})();
