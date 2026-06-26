// AI assistant endpoint: an Anthropic Claude agent that can operate on
// GoHighLevel via tool use. Write actions are confirmation-gated (see agent-tools).
const { ghlConfigured } = require('./_lib/ghl-client');
const { anthropicTools, runTool } = require('./_lib/agent-tools');
const crypto = require('crypto');

let _kv;
try { _kv = require('@vercel/kv').kv; } catch { _kv = null; }

async function kvGet(key) {
  if (!_kv) return null;
  try { return await _kv.get(key); } catch { return null; }
}
async function kvSet(key, value, opts) {
  if (!_kv) return;
  try { await _kv.set(key, value, opts); } catch { /* best-effort */ }
}
async function kvDel(key) {
  if (!_kv) return;
  try { await _kv.del(key); } catch { /* best-effort */ }
}

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MAX_STEPS = 10;
const BULK_TOOLS = new Set(['bulk_update_contacts', 'bulk_tag_contacts']);
const CONFIRM_RE = /^(yes|y|yeah|yep|confirm|confirmed|go ahead|do it|proceed|ok|okay|sure|approve|approved)\.?!?$/i;

function isConfirmMessage(text) {
  return CONFIRM_RE.test(String(text || '').trim());
}

function formatBulkPreviewReply(toolName, input) {
  const target = input.tag
    ? `all contacts with tag "${input.tag}"`
    : `${(input.contactIds || []).length} contact(s)`;
  if (toolName === 'bulk_update_contacts') {
    const fields = input.fields ? JSON.stringify(input.fields) : 'fields';
    return `Ready to update ${target} → ${fields}.\n\nReply **yes** to start processing.`;
  }
  const mode = input.mode === 'remove' ? 'remove' : 'add';
  const tags = Array.isArray(input.tags) ? input.tags.join(', ') : String(input.tags || '');
  return `Ready to ${mode} tag(s) "${tags}" on ${target}.\n\nReply **yes** to start processing.`;
}

function bulkJobFromResult(result) {
  if (!result || !result.bulkJobId || !(result.total == null || result.total > 0)) return null;
  return { id: result.bulkJobId, total: result.total ?? null, op: result.op };
}

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
- Use the read tools freely to look things up (search_contacts, search_by_tag, get_contact, list_pipelines, list_users, list_workflows, list_calendars, list_tags, list_custom_fields, search_opportunities, get_opportunity, get_notes, get_tasks, list_conversations, get_messages).
- IMPORTANT: When searching for contacts by tag, ALWAYS use search_by_tag instead of search_contacts. search_contacts is capped at 20 results and uses free-text which misses contacts. search_by_tag paginates through ALL contacts with that tag. For multiple tags, pass allTags to get only contacts with ALL specified tags.
- CRITICAL: To change MANY contacts at once (more than ~3) — e.g. set a source for everyone with a tag, or add/remove a tag in bulk — you MUST use bulk_update_contacts or bulk_tag_contacts. NEVER loop update_contact/add_tags/remove_tags one contact at a time for many contacts; that WILL time out the request. The bulk tools queue a background job that the dashboard processes automatically in chunks, so ONE confirmation handles any number of contacts.
  - Do NOT call search_by_tag before a bulk action — it is slow and can time out the chat. Pass tag (+ allTags for AND filtering) directly to the bulk tool; the dashboard resolves targets in the background.
  - Only pass contactIds if the user gave you a short explicit list (under ~20). Never pass hundreds of ids from a prior search.
  - After queueing, in ONE short sentence tell the user it's now processing with live progress. Do NOT call any tools to verify the results afterward and do NOT re-search — the dashboard handles it.
  - If the user asks again or asks to retry, ALWAYS create a fresh bulk job by calling the tool again. NEVER tell the user a previous job is "already processing" or "no need to re-run" — always re-queue.
- CONTACT FIELDS: Standard contact fields are firstName, lastName, name, email, phone, companyName, address1, city, state, country, postalCode, website, source, tags, assignedTo. "Pipeline", "stage", and opportunity-related values are NOT contact fields — those belong on opportunities (use create_opportunity/update_opportunity). For any other custom field (e.g. "Industry", a custom "Country" field, etc.), it is treated as a custom field automatically by name — but if you are unsure a field exists, call list_custom_fields first. If an update fails with "Unknown contact field", tell the user that field doesn't exist on contacts and suggest list_custom_fields or an opportunity update.
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

const CLAUDE_CALL_TIMEOUT_MS = 28000;

async function callClaude(apiKey, messages, model) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CLAUDE_CALL_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(ANTHROPIC_URL, {
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
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    // Timeout/abort or network error — treat as retryable so we can fall back.
    const err = new Error(e.name === 'AbortError' ? `Model ${model} timed out` : String(e && e.message || e));
    err.status = 503;
    throw err;
  }
  clearTimeout(timer);
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`Anthropic error (${res.status}): ${text.slice(0, 500)}`);
    err.status = res.status;
    err.responseBody = text;
    throw err;
  }
  return JSON.parse(text);
}

// Run async jobs with bounded concurrency, preserving result order.
// Used to execute many tool calls (e.g. bulk contact updates) in parallel
// so a batch write doesn't run for 60s+ and time out the function.
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function runner() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  const runners = Array.from({ length: Math.min(limit, items.length) }, runner);
  await Promise.all(runners);
  return results;
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

    const chatId = body.chatId || crypto.randomUUID();
    const kvKey = `chat:${chatId}`;
    const KV_TTL = 3600; // 1 hour

    // Load existing conversation from KV, or start fresh.
    let messages = [];
    if (body.chatId) {
      const stored = await kvGet(kvKey);
      if (Array.isArray(stored)) messages = stored;
    }

    // Append the new user message.
    const userText = body.message || (Array.isArray(body.messages) && body.messages.length
      ? body.messages[body.messages.length - 1].content : null);
    if (!userText) {
      res.status(400).json({ ok: false, error: 'No message provided.' });
      return;
    }
    messages.push({ role: 'user', content: userText });

    // Confirming a bulk action — skip Claude entirely (avoids serverless timeout).
    if (isConfirmMessage(userText)) {
      const pending = await kvGet(`pending:${chatId}`);
      if (pending && BULK_TOOLS.has(pending.tool)) {
        const result = await runTool(pending.tool, { ...pending.input, confirmed: true });
        await kvDel(`pending:${chatId}`);
        const reply = (result && result.message) || 'Bulk job queued.';
        const bulkJob = bulkJobFromResult(result);
        messages.push({ role: 'assistant', content: reply });
        await kvSet(kvKey, messages, { ex: KV_TTL });
        res.status(200).json({
          ok: true,
          reply,
          actions: [{ tool: pending.tool, input: pending.input, executed: !!(result && result.ok), preview: false }],
          chatId,
          model: preferredModel,
          bulkJob,
        });
        return;
      }
    }

    const preferredModel = body.model || DEFAULT_MODEL;
    const actions = [];
    let usedModel = preferredModel;
    let bulkJob = null;
    const START = Date.now();
    const DEADLINE_MS = 42000; // return gracefully before Vercel's 60s hard cap

    for (let step = 0; step < MAX_STEPS; step++) {
      // If we're running low on time, stop and return cleanly rather than
      // letting Vercel hard-timeout (which returns an HTML error page).
      if (Date.now() - START > DEADLINE_MS) {
        await kvSet(kvKey, messages, { ex: KV_TTL });
        res.status(200).json({
          ok: true,
          reply: bulkJob
            ? "The bulk job is queued and the dashboard is processing it below."
            : "I'm still working on this — it's a large request. Say \"continue\" and I'll pick up where I left off.",
          actions,
          chatId,
          model: usedModel,
          fallback: usedModel !== preferredModel,
          bulkJob,
        });
        return;
      }

      const { result: reply, model: actualModel } = await callClaudeWithFallback(apiKey, messages, usedModel);
      usedModel = actualModel;

      messages.push({ role: 'assistant', content: reply.content });

      if (reply.stop_reason !== 'tool_use') {
        const textOut = (reply.content || [])
          .filter(b => b.type === 'text')
          .map(b => b.text)
          .join('\n')
          .trim();
        await kvSet(kvKey, messages, { ex: KV_TTL });
        res.status(200).json({
          ok: true,
          reply: textOut || '(no response)',
          actions,
          chatId,
          model: usedModel,
          fallback: usedModel !== preferredModel,
          bulkJob,
        });
        return;
      }

      const toolBlocks = reply.content.filter(b => b.type === 'tool_use');
      // Execute tool calls with bounded concurrency (5 at a time) so bulk
      // operations like updating 19 contacts finish in seconds, not minutes.
      const executed = await mapWithConcurrency(toolBlocks, 5, async (block) => {
        const result = await runTool(block.name, block.input || {});
        return { block, result };
      });
      const toolResults = [];
      let bulkReply = null;
      let pendingBulkPreview = null;
      for (const { block, result } of executed) {
        const didRun = !(result && result.preview) && !(result && result.error);
        actions.push({ tool: block.name, input: block.input, executed: didRun, preview: !!(result && result.preview) });
        if (result && result.bulkJobId && (result.total == null || result.total > 0)) {
          bulkJob = { id: result.bulkJobId, total: result.total ?? null, op: result.op };
          if (result.ok && result.message) bulkReply = result.message;
        }
        if (result && result.preview && BULK_TOOLS.has(block.name)) {
          const input = block.input || result.proposed || {};
          pendingBulkPreview = { tool: block.name, input, reply: formatBulkPreviewReply(block.name, input) };
          await kvSet(`pending:${chatId}`, { tool: block.name, input }, { ex: KV_TTL });
        }
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
      }
      messages.push({ role: 'user', content: toolResults });

      if (pendingBulkPreview) {
        await kvSet(kvKey, messages, { ex: KV_TTL });
        res.status(200).json({
          ok: true,
          reply: pendingBulkPreview.reply,
          actions,
          chatId,
          model: usedModel,
          fallback: usedModel !== preferredModel,
        });
        return;
      }

      // Bulk job queued — return immediately so the client can run /api/bulk
      // without waiting for another Claude round-trip (which often hits 504).
      if (bulkJob && bulkReply) {
        await kvSet(kvKey, messages, { ex: KV_TTL });
        res.status(200).json({
          ok: true,
          reply: bulkReply,
          actions,
          chatId,
          model: usedModel,
          fallback: usedModel !== preferredModel,
          bulkJob,
        });
        return;
      }
    }

    await kvSet(kvKey, messages, { ex: KV_TTL });
    res.status(200).json({ ok: true, reply: 'Stopped after too many steps. Please refine your request.', actions, chatId, model: usedModel });
  } catch (err) {
    res.status(500).json({ ok: false, error: String((err && err.message) || err) });
  }
};
