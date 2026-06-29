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

const CLAUDE_CALL_TIMEOUT_MS = 24000;
// Total wall-clock budget for the whole request. Must stay safely under
// Vercel's 60s hard maxDuration so we always return parseable JSON instead of
// an HTML 504 page (which the client can only show as a generic timeout).
const FUNCTION_BUDGET_MS = 50000;
// Buffer reserved after a model call for tool execution + writing the response.
const RESPONSE_BUFFER_MS = 4000;
// Don't even start another model round-trip unless this much budget remains.
const MIN_STEP_BUDGET_MS = 9000;

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

    const chatId = body.chatId || crypto.randomUUID();
    const kvKey = `chat:${chatId}`;
    const KV_TTL = 3600; // 1 hour
    const preferredModel = body.model || DEFAULT_MODEL;
    const actions = [];
    let usedModel = preferredModel;
    let bulkJob = null;

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
      sendJson(400, { ok: false, error: 'No message provided.' });
      return;
    }
    messages.push({ role: 'user', content: userText });

    // Safety net: even if a model call or a tool (e.g. GHL rate-limit backoff)
    // runs long, fire a clean JSON response just before the function would be
    // hard-killed. Background work keeps running but the client gets an answer.
    budgetTimer = setTimeout(() => {
      kvSet(kvKey, messages, { ex: KV_TTL }).catch(() => {});
      sendJson(200, {
        ok: true,
        reply: bulkJob
          ? 'The bulk job is queued and the dashboard is processing it below.'
          : "I'm still working on this — it's taking longer than usual. Say \"continue\" and I'll pick up where I left off.",
        actions,
        chatId,
        model: usedModel,
        fallback: usedModel !== preferredModel,
        bulkJob,
      });
    }, FUNCTION_BUDGET_MS);

    // Confirming a bulk action — skip Claude entirely (avoids serverless timeout).
    if (isConfirmMessage(userText)) {
      const pending = await kvGet(`pending:${chatId}`);
      if (pending && BULK_TOOLS.has(pending.tool)) {
        const result = await runTool(pending.tool, { ...pending.input, confirmed: true });
        await kvDel(`pending:${chatId}`);
        const reply = (result && result.message) || 'Bulk job queued.';
        bulkJob = bulkJobFromResult(result);
        messages.push({ role: 'assistant', content: reply });
        await kvSet(kvKey, messages, { ex: KV_TTL });
        sendJson(200, {
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

    const START = Date.now();
    const deadlineAt = START + FUNCTION_BUDGET_MS;

    // Return a clean JSON "still working" response instead of letting Vercel
    // hard-timeout and serve an unparseable HTML 504 page.
    const returnGracefully = async () => {
      await kvSet(kvKey, messages, { ex: KV_TTL });
      sendJson(200, {
        ok: true,
        reply: bulkJob
          ? 'The bulk job is queued and the dashboard is processing it below.'
          : "I'm still working on this — it's a large request. Say \"continue\" and I'll pick up where I left off.",
        actions,
        chatId,
        model: usedModel,
        fallback: usedModel !== preferredModel,
        bulkJob,
      });
    };

    for (let step = 0; step < MAX_STEPS; step++) {
      // Don't start a model round-trip we can't finish before the budget runs
      // out; return cleanly so the client always gets parseable JSON.
      if (sent || deadlineAt - Date.now() < MIN_STEP_BUDGET_MS) {
        await returnGracefully();
        return;
      }

      let reply, actualModel;
      try {
        ({ result: reply, model: actualModel } = await callClaudeWithFallback(apiKey, messages, usedModel, deadlineAt));
      } catch (err) {
        // Out of time / model unreachable: degrade to a graceful response rather
        // than a 500 or a hard timeout.
        if (err && (err.budgetExhausted || err.status === 503 || err.status === 529)) {
          await returnGracefully();
          return;
        }
        throw err;
      }
      usedModel = actualModel;

      messages.push({ role: 'assistant', content: reply.content });

      if (reply.stop_reason !== 'tool_use') {
        const textOut = (reply.content || [])
          .filter(b => b.type === 'text')
          .map(b => b.text)
          .join('\n')
          .trim();
        await kvSet(kvKey, messages, { ex: KV_TTL });
        sendJson(200, {
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
      // The safety timer may have already responded while tools ran long.
      if (sent) return;
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
        sendJson(200, {
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
        sendJson(200, {
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
    sendJson(200, { ok: true, reply: 'Stopped after too many steps. Please refine your request.', actions, chatId, model: usedModel });
  } catch (err) {
    sendJson(500, { ok: false, error: String((err && err.message) || err) });
  } finally {
    if (budgetTimer) { clearTimeout(budgetTimer); budgetTimer = null; }
  }
};
