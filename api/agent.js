// AI assistant endpoint: an Anthropic Claude agent that can operate on
// GoHighLevel via tool use. Write actions are confirmation-gated (see agent-tools).
const { ghlConfigured } = require('./_lib/ghl-client');
const { anthropicTools, runTool } = require('./_lib/agent-tools');

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MAX_STEPS = 10;

const AVAILABLE_MODELS = [
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  { id: 'claude-opus-4-8',  label: 'Claude Opus 4.8' },
  { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
];
const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

function buildFallbackOrder(preferred) {
  const ids = AVAILABLE_MODELS.map(m => m.id);
  if (!preferred || !ids.includes(preferred)) preferred = DEFAULT_MODEL;
  return [preferred, ...ids.filter(id => id !== preferred)];
}

function isRetryableError(status, body) {
  if (status === 529 || status === 503 || status === 502) return true;
  if (status === 500) return true;
  if (status === 400 && /not available|does not exist|not found/i.test(body)) return true;
  if (status === 404) return true;
  return false;
}

const SYSTEM_PROMPT = `You are the CeleriTech CRM assistant, embedded in a GoHighLevel marketing dashboard.
You help the user manage their GoHighLevel CRM by calling tools.

What you CAN do (all via the GoHighLevel API):
- Contacts: search, view full details, create, update any field (incl. custom fields), delete, add/remove tags, add notes, list/read notes.
- Tasks: list, create, update (e.g. mark complete), assign to a user with a due date.
- Opportunities: search, view, create, update (move stage, change value/status), delete.
- Pipelines & users: list pipelines/stages and location users (to find ids for assignment).
- Tags: list location tags, create a new tag.
- Custom fields: list field definitions (id, name, fieldKey) so you can update the right key.
- Conversations/messaging: list conversations, read messages, and send SMS or Email to a contact.
- Calendars/appointments: list calendars and book appointments for a contact.
- Automations/workflows: list existing workflows, and enroll or remove a contact from one.

What you CANNOT do (a real GoHighLevel API limitation — be honest about this):
- You cannot BUILD or configure new workflows/automations or Conversation AI bots via the API; that must be done in the GoHighLevel dashboard (Automation → Workflows). You CAN, however, enroll contacts into workflows that already exist, and tagging a contact often triggers their workflows.

Rules:
- Use the read tools freely to look things up (search_contacts, get_contact, list_pipelines, list_users, list_workflows, list_calendars, list_tags, list_custom_fields, search_opportunities, get_opportunity, get_notes, get_tasks, list_conversations, get_messages).
- For ANY write action (add_tags, remove_tags, update_contact, create_contact, delete_contact, create_opportunity, update_opportunity, delete_opportunity, add_note, create_task, update_task, send_message, book_appointment, add_to_workflow, remove_from_workflow, create_tag):
  1. First figure out the exact change (look up ids as needed).
  2. Clearly describe to the user what you are about to do and ask them to confirm.
  3. Only after the user explicitly says yes/confirm, call the write tool with confirmed=true.
  If you call a write tool without confirmed=true you'll get a CONFIRMATION REQUIRED preview — relay that to the user and wait.
- Sending messages, deleting records, and enrolling into workflows are especially sensitive: always confirm first and never send/delete without explicit approval.
- When you need a pipeline/stage/user/workflow/calendar id, look it up rather than guessing.
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

async function callClaude(apiKey, messages, model) {
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: anthropicTools(),
      messages,
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`Anthropic error (${res.status}): ${text.slice(0, 500)}`);
    err.status = res.status;
    err.responseBody = text;
    throw err;
  }
  return JSON.parse(text);
}

async function callClaudeWithFallback(apiKey, messages, preferredModel) {
  const chain = buildFallbackOrder(preferredModel);
  let lastErr;
  for (const model of chain) {
    try {
      const result = await callClaude(apiKey, messages, model);
      return { result, model };
    } catch (err) {
      lastErr = err;
      if (!isRetryableError(err.status, err.responseBody || '')) throw err;
    }
  }
  throw lastErr;
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

    // GET models list
    if (body.action === 'list_models') {
      res.status(200).json({ ok: true, models: AVAILABLE_MODELS, default: DEFAULT_MODEL });
      return;
    }

    // Use full Anthropic history if available (preserves tool calls/results),
    // otherwise fall back to text-only conversion for backward compat.
    let messages;
    if (Array.isArray(body.history) && body.history.length) {
      messages = body.history;
    } else {
      messages = toAnthropicMessages(body.messages);
    }
    if (!messages.length) {
      res.status(400).json({ ok: false, error: 'No messages provided.' });
      return;
    }

    const preferredModel = body.model || DEFAULT_MODEL;
    const actions = [];
    let usedModel = preferredModel;

    for (let step = 0; step < MAX_STEPS; step++) {
      const { result: reply, model: actualModel } = await callClaudeWithFallback(apiKey, messages, usedModel);
      usedModel = actualModel;

      messages.push({ role: 'assistant', content: reply.content });

      if (reply.stop_reason !== 'tool_use') {
        const textOut = (reply.content || [])
          .filter(b => b.type === 'text')
          .map(b => b.text)
          .join('\n')
          .trim();
        res.status(200).json({
          ok: true,
          reply: textOut || '(no response)',
          actions,
          model: usedModel,
          fallback: usedModel !== preferredModel,
          history: messages,
        });
        return;
      }

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

    res.status(200).json({ ok: true, reply: 'Stopped after too many steps. Please refine your request.', actions, model: usedModel, history: messages });
  } catch (err) {
    res.status(500).json({ ok: false, error: String((err && err.message) || err) });
  }
};
