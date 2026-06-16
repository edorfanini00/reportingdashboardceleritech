// AI assistant endpoint: an Anthropic Claude agent that can operate on
// GoHighLevel via tool use. Write actions are confirmation-gated (see agent-tools).
const { ghlConfigured } = require('./_lib/ghl-client');
const { anthropicTools, runTool } = require('./_lib/agent-tools');

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest';
const MAX_STEPS = 10;

const SYSTEM_PROMPT = `You are the CeleriTech CRM assistant, embedded in a GoHighLevel marketing dashboard.
You help the user manage their GoHighLevel CRM by calling tools.

Rules:
- Use the read tools (search_contacts, get_contact, list_pipelines, list_users) freely to look things up.
- For ANY write action (add_tags, remove_tags, update_contact, create_contact, create_opportunity, update_opportunity):
  1. First figure out the exact change (look up ids as needed).
  2. Clearly describe to the user what you are about to do and ask them to confirm.
  3. Only after the user explicitly says yes/confirm, call the write tool with confirmed=true.
  If you call a write tool without confirmed=true you'll get a CONFIRMATION REQUIRED preview — relay that to the user and wait.
- When you need a pipeline/stage/user id, look it up with list_pipelines / list_users rather than guessing.
- Be concise. Confirm what was done after a successful write. Use the user's own words for tags/sources verbatim.
- If GoHighLevel is not configured, tell the user to set GHL credentials in Vercel.`;

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body.length) {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

// Convert the simple {role, content} chat history into Anthropic messages.
function toAnthropicMessages(history) {
  return (history || [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map(m => ({ role: m.role, content: m.content }));
}

async function callClaude(apiKey, messages) {
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      tools: anthropicTools(),
      messages,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Anthropic error (${res.status}): ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Use POST' });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ ok: false, error: 'AI not configured. Add ANTHROPIC_API_KEY in Vercel env vars.' });
    return;
  }
  if (!ghlConfigured()) {
    res.status(500).json({ ok: false, error: 'GoHighLevel not configured. Add GHL_API_KEY and GHL_LOCATION_ID.' });
    return;
  }

  try {
    const body = await readBody(req);
    const messages = toAnthropicMessages(body.messages);
    if (!messages.length) {
      res.status(400).json({ ok: false, error: 'No messages provided.' });
      return;
    }

    const actions = []; // tools actually executed (for the UI activity log)

    for (let step = 0; step < MAX_STEPS; step++) {
      const reply = await callClaude(apiKey, messages);

      // Persist the assistant turn (may include tool_use blocks).
      messages.push({ role: 'assistant', content: reply.content });

      if (reply.stop_reason !== 'tool_use') {
        const textOut = (reply.content || [])
          .filter(b => b.type === 'text')
          .map(b => b.text)
          .join('\n')
          .trim();
        res.status(200).json({ ok: true, reply: textOut || '(no response)', actions });
        return;
      }

      // Execute each requested tool and feed results back.
      const toolResults = [];
      for (const block of reply.content) {
        if (block.type !== 'tool_use') continue;
        const result = await runTool(block.name, block.input || {});
        const executed = !(result && result.preview) && !(result && result.error);
        actions.push({ tool: block.name, input: block.input, executed, preview: !!(result && result.preview) });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
      }
      messages.push({ role: 'user', content: toolResults });
    }

    res.status(200).json({ ok: true, reply: 'Stopped after too many steps. Please refine your request.', actions });
  } catch (err) {
    res.status(500).json({ ok: false, error: String((err && err.message) || err) });
  }
};
