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
const MAX_STEPS = 12;

// ---- Context window management ----
// Claude models support ~200k tokens of context. We keep the conversation as
// large as possible (for long memory) while protecting against unbounded
// growth from huge tool results.
const MAX_CONTEXT_CHARS = 400000;      // ~100k tokens sent to the model
const MAX_TOOL_RESULT_CHARS = 20000;   // cap a single tool result blob
const MAX_STORED_MESSAGES = 200;       // cap what we persist in KV

function truncateForContext(str, max) {
  if (typeof str !== 'string' || str.length <= max) return str;
  return str.slice(0, max) + `\n…[truncated ${str.length - max} chars]`;
}

function messageSize(m) {
  try { return JSON.stringify(m).length; } catch { return 0; }
}

// Find the earliest index we can cut at without breaking Anthropic's
// tool_use/tool_result pairing: a user turn whose content is a plain string.
function isCleanCutPoint(m) {
  return m && m.role === 'user' && typeof m.content === 'string';
}

// Build the message list actually sent to the model. Keeps as much history as
// fits in MAX_CONTEXT_CHARS: first compacts old bulky tool results, then (only
// if still too big) drops the oldest turns at a clean boundary.
function prepareMessagesForModel(messages) {
  let msgs = messages.map(m => ({ ...m }));
  let total = msgs.reduce((s, m) => s + messageSize(m), 0);
  if (total <= MAX_CONTEXT_CHARS) return msgs;

  // Pass 1: shrink tool_result blocks in the OLDER half of the conversation.
  const protectFrom = Math.max(0, msgs.length - 12); // keep recent turns intact
  for (let i = 0; i < protectFrom && total > MAX_CONTEXT_CHARS; i++) {
    const m = msgs[i];
    if (m.role === 'user' && Array.isArray(m.content)) {
      const before = messageSize(m);
      m.content = m.content.map(b =>
        b && b.type === 'tool_result' && typeof b.content === 'string' && b.content.length > 2000
          ? { ...b, content: truncateForContext(b.content, 2000) }
          : b
      );
      total += messageSize(m) - before;
    }
  }
  if (total <= MAX_CONTEXT_CHARS) return msgs;

  // Pass 2: drop oldest turns at a clean user-text boundary.
  let cut = 0;
  while (total > MAX_CONTEXT_CHARS && cut < msgs.length - 6) {
    let next = cut + 1;
    while (next < msgs.length - 6 && !isCleanCutPoint(msgs[next])) next++;
    if (next >= msgs.length - 6) break;
    for (let i = cut; i < next; i++) total -= messageSize(msgs[i]);
    cut = next;
  }
  if (cut > 0) {
    msgs = msgs.slice(cut);
    // First kept message is a clean user-text turn; annotate it rather than
    // inserting a new turn (roles must alternate).
    if (msgs.length && typeof msgs[0].content === 'string') {
      msgs[0] = { ...msgs[0], content: '[Earlier conversation trimmed for length.]\n\n' + msgs[0].content };
    }
  }
  return msgs;
}

// Cap what we persist so a very long chat can't outgrow KV limits (which would
// make saves silently fail and wipe the assistant's memory).
function capStoredMessages(messages) {
  if (messages.length <= MAX_STORED_MESSAGES) return messages;
  let cut = messages.length - MAX_STORED_MESSAGES;
  while (cut < messages.length && !isCleanCutPoint(messages[cut])) cut++;
  return messages.slice(cut);
}
const BULK_TOOLS = new Set(['bulk_update_contacts', 'bulk_tag_contacts']);
const CONFIRM_RE = /^(yes|y|yeah|yep|confirm|confirmed|go ahead|do it|proceed|ok|okay|sure|approve|approved)\.?!?$/i;

function isConfirmMessage(text) {
  return CONFIRM_RE.test(String(text || '').trim());
}

function describeBulkAction(toolName, input) {
  const target = input.tag
    ? `all contacts with tag "${input.tag}"`
    : `${(input.contactIds || []).length} contact(s)`;
  if (toolName === 'bulk_update_contacts') {
    const fields = input.fields ? JSON.stringify(input.fields) : 'fields';
    return `update ${target} → ${fields}`;
  }
  const mode = input.mode === 'remove' ? 'remove' : 'add';
  const tags = Array.isArray(input.tags) ? input.tags.join(', ') : String(input.tags || '');
  return `${mode} tag(s) "${tags}" on ${target}`;
}

function formatBulkPreviewReply(previews) {
  if (previews.length === 1) {
    return `Ready to ${describeBulkAction(previews[0].tool, previews[0].input)}.\n\nReply **yes** to start processing.`;
  }
  const lines = previews.map((p, i) => `${i + 1}. ${describeBulkAction(p.tool, p.input)}`);
  return `Ready to run ${previews.length} bulk jobs:\n${lines.join('\n')}\n\nReply **yes** to start ALL of them.`;
}

function bulkJobFromResult(result) {
  if (!result || !result.ok || !result.bulk || !result.bulkJob) return null;
  if (!(result.total == null || result.total > 0)) return null;
  return result.bulkJob;
}

const AVAILABLE_MODELS = [
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  { id: 'claude-opus-4-8',  label: 'Claude Opus 4.8' },
  { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
];
const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

// Fallback priority is fastest-first. When the preferred model is slow/times
// out (the Anthropic API has periods of high latency), we fall over to faster
// models so the request still completes within the serverless budget. The
// slowest model (opus) is intentionally LAST so we never burn the budget on it.
const FALLBACK_PRIORITY = ['claude-sonnet-4-5', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-opus-4-8'];

function buildFallbackOrder(preferred) {
  const ids = AVAILABLE_MODELS.map(m => m.id);
  if (!preferred || !ids.includes(preferred)) preferred = DEFAULT_MODEL;
  return [preferred, ...FALLBACK_PRIORITY.filter(id => id !== preferred && ids.includes(id))];
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

MEMORY & CONTEXT — this is critical:
- You have the FULL conversation history. USE IT. Before answering, re-read the recent turns and connect the current message to what was already discussed.
- Resolve references from context: "them", "those contacts", "that tag", "the same ones", "do it again", "the second one" refer to things mentioned earlier in this conversation. Never ask the user to repeat information they already gave you.
- Remember decisions, ids, tag names, pipelines, and search results from earlier turns and reuse them instead of re-looking them up (unless they may have changed).
- If the user's message is short or vague (e.g. "yes", "the other one", "now remove it"), interpret it in the context of your immediately preceding message.
- Only ask a clarifying question when the request is genuinely ambiguous even after considering the whole conversation — and then ask ONE specific question, not a list.

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
- Be concise but complete. Confirm what was done after a successful write. Use the user's own words for tags/sources verbatim.
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

const CLAUDE_CALL_TIMEOUT_MS = 25000;
// Total wall-clock budget for ONE HTTP request. Deliberately short: many
// networks (VPNs, proxies, mobile hotspots) silently kill HTTP requests that
// stay open longer than ~30s, which surfaces as "Failed to fetch" in the
// browser. Long turns instead chain across several short requests: the server
// returns `continuable` with the conversation state and the client resumes
// immediately. Must also stay under Vercel's 60s hard maxDuration.
const FUNCTION_BUDGET_MS = 28000;
// Buffer reserved after a model call for tool execution + writing the response.
const RESPONSE_BUFFER_MS = 2000;
// Don't even start another model round-trip unless this much budget remains.
const MIN_STEP_BUDGET_MS = 8000;

async function callClaude(apiKey, messages, model, timeoutMs = CLAUDE_CALL_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1000, timeoutMs));
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
        // High enough that answers and multi-tool turns never get cut off
        // mid-thought; timeouts are handled by the abort timer, not this cap.
        model,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        tools: anthropicTools(),
        messages: prepareMessagesForModel(messages),
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

async function callClaudeWithFallback(apiKey, messages, preferredModel, deadlineAt) {
  const chain = buildFallbackOrder(preferredModel);
  let lastErr;
  for (const model of chain) {
    // Cap each call to the time we have left (minus a buffer for the response),
    // and stop trying more models once the budget is too small to finish one.
    const remaining = deadlineAt - Date.now() - RESPONSE_BUFFER_MS;
    if (remaining < MIN_STEP_BUDGET_MS) {
      const e = lastErr || new Error('Ran out of time budget before the model responded.');
      e.budgetExhausted = true;
      throw e;
    }
    const timeoutMs = Math.min(CLAUDE_CALL_TIMEOUT_MS, remaining);
    try {
      const result = await callClaude(apiKey, messages, model, timeoutMs);
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

  // Single-send guard + safety-net timer. We MUST always return parseable JSON
  // before Vercel's 60s hard cap; otherwise the client receives an HTML 504 and
  // can only show a generic "request timed out" message. sendJson ensures we
  // respond exactly once and cancels the safety timer.
  let sent = false;
  let budgetTimer = null;
  const sendJson = (status, payload) => {
    if (sent || res.writableEnded) return;
    sent = true;
    if (budgetTimer) { clearTimeout(budgetTimer); budgetTimer = null; }
    res.status(status).json(payload);
  };

  if (req.method !== 'POST') {
    sendJson(405, { ok: false, error: 'Use POST' });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    sendJson(500, { ok: false, error: 'AI not configured. Add ANTHROPIC_API_KEY in Vercel env vars.' });
    return;
  }
  if (!ghlConfigured()) {
    sendJson(500, { ok: false, error: 'GoHighLevel not configured. Add GHL_API_KEY and GHL_LOCATION_ID.' });
    return;
  }

  try {
    const body = await readBody(req);

    // GET models list
    if (body.action === 'list_models') {
      sendJson(200, { ok: true, models: AVAILABLE_MODELS, default: DEFAULT_MODEL });
      return;
    }

    // Temporary diagnostic: time a trivial call to each model with the real key.
    if (body.action === 'probe_models') {
      const out = [];
      for (const m of AVAILABLE_MODELS.map(x => x.id)) {
        const t0 = Date.now();
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 14000);
        try {
          const res = await fetch(ANTHROPIC_URL, {
            method: 'POST',
            headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
            body: JSON.stringify({ model: m, max_tokens: 8, messages: [{ role: 'user', content: 'Say hi.' }] }),
            signal: ctrl.signal,
          });
          clearTimeout(timer);
          const txt = await res.text();
          let usage; try { const j = JSON.parse(txt); usage = j.usage; } catch {}
          out.push({ model: m, ms: Date.now() - t0, status: res.status, usage, body: res.ok ? undefined : txt.slice(0, 200) });
        } catch (e) {
          clearTimeout(timer);
          out.push({ model: m, ms: Date.now() - t0, error: e.name === 'AbortError' ? 'timeout(14s)' : String(e.message) });
        }
      }
      sendJson(200, { ok: true, probe: out });
      return;
    }

    const chatId = body.chatId || crypto.randomUUID();
    const kvKey = `chat:${chatId}`;
    const KV_TTL = 60 * 60 * 24 * 7; // 7 days — long-lived chat memory
    const preferredModel = body.model || DEFAULT_MODEL;
    const actions = [];
    let usedModel = preferredModel;
    let bulkJob = null;       // first job (kept for older clients)
    let bulkJobs = [];        // ALL jobs queued this turn — the client runs each

    // Record turns that happened outside this endpoint (e.g. the client's
    // local bulk-confirm flow) so the assistant's memory stays in sync.
    if (body.action === 'append_history') {
      const stored = (await kvGet(kvKey)) || [];
      const msgs = Array.isArray(stored) ? stored : [];
      for (const t of (Array.isArray(body.turns) ? body.turns : [])) {
        if (t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string') {
          msgs.push({ role: t.role, content: t.content });
        }
      }
      await kvSet(kvKey, capStoredMessages(msgs), { ex: KV_TTL });
      sendJson(200, { ok: true, chatId });
      return;
    }

    // Load the conversation. Preference order:
    // 1. `state` echoed back by the client on a continue — the exact message
    //    array (incl. tool calls) from the previous partial response. Works
    //    with zero server-side storage.
    // 2. KV-stored conversation.
    // 3. Client-supplied plain-text history (fallback if KV lost the chat).
    let messages = [];
    if (Array.isArray(body.state) && body.state.length) {
      messages = body.state.filter(m => m && (m.role === 'user' || m.role === 'assistant') && m.content != null);
    }
    if (!messages.length && body.chatId) {
      const stored = await kvGet(kvKey);
      if (Array.isArray(stored)) messages = stored;
    }
    if (!messages.length && Array.isArray(body.history) && body.history.length) {
      messages = toAnthropicMessages(body.history);
    }

    // A "continue" resume (client auto-retry after a graceful timeout) reloads
    // the stored conversation and runs the loop again WITHOUT appending a new
    // user turn — appending one would break Anthropic's role/tool_use pairing if
    // the previous response bailed mid-step. We just sanitize a trailing,
    // unmatched assistant tool_use turn so the next model call is valid.
    const isContinue = body.continue === true;
    if (isContinue) {
      if (!messages.length) {
        sendJson(200, { ok: true, reply: 'Nothing left to continue — go ahead with a new request.', actions: [], chatId, model: usedModel });
        return;
      }
      const last = messages[messages.length - 1];
      if (last && last.role === 'assistant' && Array.isArray(last.content)
          && last.content.some(b => b && b.type === 'tool_use')) {
        messages.pop();
      }
    } else {
      const userText = body.message || (Array.isArray(body.messages) && body.messages.length
        ? body.messages[body.messages.length - 1].content : null);
      if (!userText) {
        sendJson(400, { ok: false, error: 'No message provided.' });
        return;
      }
      messages.push({ role: 'user', content: userText });
    }

    // Safety net: even if a model call or a tool (e.g. GHL rate-limit backoff)
    // runs long, fire a clean JSON response just before the function would be
    // hard-killed. Background work keeps running but the client gets an answer.
    budgetTimer = setTimeout(() => {
      kvSet(kvKey, capStoredMessages(messages), { ex: KV_TTL }).catch(() => {});
      sendJson(200, {
        ok: true,
        reply: bulkJob
          ? 'The bulk job is queued and the dashboard is processing it below.'
          : "I'm still working on this — it's taking longer than usual. Let me keep going…",
        actions,
        chatId,
        model: usedModel,
        fallback: usedModel !== preferredModel,
        bulkJob,
        bulkJobs: bulkJobs.length ? bulkJobs : undefined,
        continuable: !bulkJob,
        state: bulkJob ? undefined : messages,
      });
    }, FUNCTION_BUDGET_MS);

    // Confirming pending bulk action(s) — skip Claude entirely (fast path).
    if (!isContinue && isConfirmMessage(body.message)) {
      const pending = await kvGet(`pending:${chatId}`);
      const pendingList = pending && Array.isArray(pending.list)
        ? pending.list.filter(p => p && BULK_TOOLS.has(p.tool))
        : (pending && BULK_TOOLS.has(pending.tool) ? [pending] : []);
      if (pendingList.length) {
        const confirmActions = [];
        const msgs = [];
        for (const p of pendingList) {
          const result = await runTool(p.tool, { ...p.input, confirmed: true });
          const jobSpec = bulkJobFromResult(result);
          if (jobSpec) bulkJobs.push(jobSpec);
          if (result && result.message) msgs.push(result.message);
          confirmActions.push({ tool: p.tool, input: p.input, executed: !!(result && result.ok), preview: false });
        }
        await kvDel(`pending:${chatId}`);
        bulkJob = bulkJobs[0] || null;
        const reply = bulkJobs.length > 1
          ? `Queued ${bulkJobs.length} bulk jobs — the dashboard is processing them one after another below.`
          : (msgs[0] || 'Bulk job queued.');
        messages.push({ role: 'assistant', content: reply });
        await kvSet(kvKey, capStoredMessages(messages), { ex: KV_TTL });
        sendJson(200, {
          ok: true,
          reply,
          actions: confirmActions,
          chatId,
          model: preferredModel,
          bulkJob,
          bulkJobs: bulkJobs.length ? bulkJobs : undefined,
        });
        return;
      }
    }

    const START = Date.now();
    const deadlineAt = START + FUNCTION_BUDGET_MS;
    console.log('[agent] start', JSON.stringify({
      chatId, isContinue, preferredModel, msgs: messages.length,
      userText: (body.message || '').slice(0, 160),
    }));

    // Return a clean JSON "still working" response instead of letting Vercel
    // hard-timeout and serve an unparseable HTML 504 page.
    const returnGracefully = async () => {
      await kvSet(kvKey, capStoredMessages(messages), { ex: KV_TTL });
      sendJson(200, {
        ok: true,
        reply: bulkJob
          ? 'The bulk job is queued and the dashboard is processing it below.'
          : "I'm still working on this — it's a large request. Let me keep going…",
        actions,
        chatId,
        model: usedModel,
        fallback: usedModel !== preferredModel,
        bulkJob,
        bulkJobs: bulkJobs.length ? bulkJobs : undefined,
        continuable: !bulkJob,
        // Exact conversation state for the client to echo back on continue —
        // resuming works even with no server-side storage at all.
        state: bulkJob ? undefined : messages,
      });
    };

    for (let step = 0; step < MAX_STEPS; step++) {
      // Don't start a model round-trip we can't finish before the budget runs
      // out; return cleanly so the client always gets parseable JSON.
      if (sent || deadlineAt - Date.now() < MIN_STEP_BUDGET_MS) {
        await returnGracefully();
        return;
      }

      const tCall = Date.now();
      let reply, actualModel;
      try {
        ({ result: reply, model: actualModel } = await callClaudeWithFallback(apiKey, messages, usedModel, deadlineAt));
      } catch (err) {
        console.log('[agent] claude error', JSON.stringify({ step, elapsed: Date.now() - START, status: err && err.status, msg: String((err && err.message) || err).slice(0, 200) }));
        // Out of time / model unreachable: degrade to a graceful response rather
        // than a 500 or a hard timeout.
        if (err && (err.budgetExhausted || err.status === 503 || err.status === 529)) {
          await returnGracefully();
          return;
        }
        throw err;
      }
      usedModel = actualModel;
      console.log('[agent] claude replied', JSON.stringify({
        step, model: usedModel, stop: reply.stop_reason,
        callMs: Date.now() - tCall, elapsed: Date.now() - START,
        tools: (reply.content || []).filter(b => b.type === 'tool_use').map(b => b.name),
      }));

      messages.push({ role: 'assistant', content: reply.content });

      if (reply.stop_reason !== 'tool_use') {
        const textOut = (reply.content || [])
          .filter(b => b.type === 'text')
          .map(b => b.text)
          .join('\n')
          .trim();
        await kvSet(kvKey, capStoredMessages(messages), { ex: KV_TTL });
        sendJson(200, {
          ok: true,
          reply: textOut || '(no response)',
          actions,
          chatId,
          model: usedModel,
          fallback: usedModel !== preferredModel,
          bulkJob,
          bulkJobs: bulkJobs.length ? bulkJobs : undefined,
        });
        return;
      }

      const toolBlocks = reply.content.filter(b => b.type === 'tool_use');
      // Execute tool calls with bounded concurrency (5 at a time) so bulk
      // operations like updating 19 contacts finish in seconds, not minutes.
      const executed = await mapWithConcurrency(toolBlocks, 5, async (block) => {
        const t0 = Date.now();
        const result = await runTool(block.name, block.input || {});
        console.log('[agent] tool', JSON.stringify({
          name: block.name, ms: Date.now() - t0,
          preview: !!(result && result.preview), error: result && result.error ? String(result.error).slice(0, 160) : undefined,
          bulk: !!(result && result.bulk), total: result && result.total,
          input: JSON.stringify(block.input || {}).slice(0, 200),
        }));
        return { block, result };
      });
      // The safety timer may have already responded while tools ran long.
      if (sent) return;
      const toolResults = [];
      let bulkReply = null;
      const bulkPreviews = [];
      for (const { block, result } of executed) {
        const didRun = !(result && result.preview) && !(result && result.error);
        actions.push({ tool: block.name, input: block.input, executed: didRun, preview: !!(result && result.preview) });
        const jobSpec = bulkJobFromResult(result);
        if (jobSpec) {
          bulkJobs.push(jobSpec);
          bulkJob = bulkJobs[0];
          if (result.message) bulkReply = result.message;
        }
        if (result && result.preview && BULK_TOOLS.has(block.name)) {
          bulkPreviews.push({ tool: block.name, input: block.input || result.proposed || {} });
        }
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: truncateForContext(JSON.stringify(result), MAX_TOOL_RESULT_CHARS),
        });
      }
      messages.push({ role: 'user', content: toolResults });

      if (bulkPreviews.length) {
        // Pending bulk confirmations stay short-lived on purpose: confirming
        // a week-old "yes" against live CRM data would be dangerous.
        await kvSet(`pending:${chatId}`, { list: bulkPreviews }, { ex: 3600 });
        await kvSet(kvKey, capStoredMessages(messages), { ex: KV_TTL });
        sendJson(200, {
          ok: true,
          reply: formatBulkPreviewReply(bulkPreviews),
          actions,
          chatId,
          model: usedModel,
          fallback: usedModel !== preferredModel,
        });
        return;
      }

      // Bulk job(s) queued — return immediately so the client can run them
      // without waiting for another model round-trip.
      if (bulkJobs.length && bulkReply) {
        await kvSet(kvKey, capStoredMessages(messages), { ex: KV_TTL });
        sendJson(200, {
          ok: true,
          reply: bulkJobs.length > 1
            ? `Queued ${bulkJobs.length} bulk jobs — the dashboard is processing them one after another below.`
            : bulkReply,
          actions,
          chatId,
          model: usedModel,
          fallback: usedModel !== preferredModel,
          bulkJob,
          bulkJobs,
        });
        return;
      }
    }

    await kvSet(kvKey, capStoredMessages(messages), { ex: KV_TTL });
    sendJson(200, { ok: true, reply: 'Stopped after too many steps. Please refine your request.', actions, chatId, model: usedModel });
  } catch (err) {
    sendJson(500, { ok: false, error: String((err && err.message) || err) });
  } finally {
    if (budgetTimer) { clearTimeout(budgetTimer); budgetTimer = null; }
  }
};
