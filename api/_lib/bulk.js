// Bulk-action job queue for the AI assistant.
// Large CRM operations (e.g. "set source for all 200 contacts with tag X")
// can't run in a single serverless request without timing out. Instead we
// resolve the target contacts once, store the job in KV, and let the client
// drive processing in small chunks across many fast requests (with progress).
const crypto = require('crypto');
const ghl = require('./ghl-client');

let _kv;
try { _kv = require('@vercel/kv').kv; } catch { _kv = null; }

async function kvGet(key) {
  if (!_kv) return null;
  try { return await _kv.get(key); } catch { return null; }
}
async function kvSet(key, value, opts) {
  if (!_kv) return false;
  try { await _kv.set(key, value, opts); return true; } catch { return false; }
}

const TTL = 3600; // jobs expire after 1h
const VALID_OPS = ['update_contact', 'add_tags', 'remove_tags'];

// GHL burst limit ≈ 100 requests / 10s per location. Process one contact at a
// time with a pause between each so bulk jobs complete without 429s.
const BULK_DELAY_MS = 600; // ~1.6 contacts/sec — well under the burst ceiling
const BULK_DEFAULT_CHUNK = 3;
const RESOLVE_PAGE_LIMIT = 100;
const RESOLVE_PAGES_PER_CALL = 1; // one search page per /api/bulk request

function kvAvailable() {
  return Boolean(_kv);
}

function filterByAllTags(contacts, allTags) {
  if (!Array.isArray(allTags) || allTags.length <= 1) return contacts;
  const required = allTags.map(t => String(t).toLowerCase());
  return contacts.filter(c => {
    const cTags = (c.tags || []).map(t => String(t).toLowerCase());
    return required.every(r => cTags.includes(r));
  });
}

function finalizeResolvedIds(job) {
  let contacts = job.resolveBuffer || [];
  contacts = filterByAllTags(contacts, job.allTags);
  job.ids = [...new Set(contacts.map(c => c.id).filter(Boolean))];
  job.total = job.ids.length;
  job.resolved = true;
  job.resolving = false;
  job.done = job.total === 0;
  delete job.resolveBuffer;
  delete job.resolvePage;
}

// Resolve the list of contact ids a job will act on (full scan — scripts only).
async function resolveTargets({ contactIds, tag, allTags }) {
  if (Array.isArray(contactIds) && contactIds.length) {
    return [...new Set(contactIds.filter(Boolean))];
  }
  if (tag) {
    let results = await ghl.searchByTagEquals(tag);
    results = filterByAllTags(results, allTags);
    return [...new Set(results.map(c => c.id).filter(Boolean))];
  }
  return [];
}

function jobStatus(job) {
  return {
    jobId: job.id,
    op: job.op,
    total: job.total,
    processed: job.cursor,
    done: job.done,
    resolving: !!job.resolving,
    errorCount: job.errors.length,
    errors: job.errors.slice(0, 10),
  };
}

// Create a job. If explicit contactIds are given the job is ready immediately;
// otherwise tag-based resolution is DEFERRED to process() calls (one search page
// per request) so nothing slow runs inside the chat request.
async function createBulkJob(spec) {
  if (!VALID_OPS.includes(spec.op)) {
    throw new Error(`Unsupported bulk op: ${spec.op}`);
  }
  if (!kvAvailable()) {
    throw new Error('Bulk actions require Vercel KV. Connect a KV store to the project.');
  }

  let ids = [];
  let resolved = false;
  if (Array.isArray(spec.contactIds) && spec.contactIds.length) {
    ids = [...new Set(spec.contactIds.filter(Boolean))];
    resolved = true;
  }

  const job = {
    id: crypto.randomUUID(),
    op: spec.op,
    fields: spec.fields || null,
    tags: spec.tags || null,
    tag: spec.tag || null,
    allTags: spec.allTags || null,
    ids,
    total: resolved ? ids.length : null,
    resolved,
    resolving: !resolved && Boolean(spec.tag),
    resolvePage: 1,
    resolveBuffer: [],
    cursor: 0,
    done: resolved && ids.length === 0,
    errors: [],
    createdAt: Date.now(),
  };
  await kvSet(`bulk:${job.id}`, job, { ex: TTL });
  return job;
}

// Eagerly resolve a tag-based job's full target list (bounded by time) so the
// progress bar can show a real total ("0 / 350") right away instead of "0 / …".
// If the tag is huge and we run out of time, the job stays deferred and the
// remaining pages resolve during processing — no correctness impact.
async function resolveAll(jobId, maxMs = 8000) {
  const startT = Date.now();
  let job = await kvGet(`bulk:${jobId}`);
  if (!job) return null;
  while (!job.resolved && Date.now() - startT < maxMs) {
    await resolveNextPages(job);
    await kvSet(`bulk:${jobId}`, job, { ex: TTL });
  }
  return job;
}

// Advance tag-based resolution by up to RESOLVE_PAGES_PER_CALL pages.
async function resolveNextPages(job) {
  if (job.resolved || !job.tag) return;
  job.resolving = true;
  job.resolveBuffer = job.resolveBuffer || [];

  for (let i = 0; i < RESOLVE_PAGES_PER_CALL; i++) {
    const { batch } = await ghl.searchContactsByTagPage(job.tag, job.resolvePage, RESOLVE_PAGE_LIMIT);
    job.resolveBuffer.push(...batch);
    if (batch.length < RESOLVE_PAGE_LIMIT) {
      finalizeResolvedIds(job);
      return;
    }
    job.resolvePage += 1;
  }
}

// Process the next `chunkSize` contacts of a job. Safe to call repeatedly.
async function processBulkJob(jobId, chunkSize = BULK_DEFAULT_CHUNK) {
  const job = await kvGet(`bulk:${jobId}`);
  if (!job) return { error: 'Job not found or expired.' };

  if (!job.resolved) {
    await resolveNextPages(job);
    await kvSet(`bulk:${jobId}`, job, { ex: TTL });
    if (!job.resolved) return jobStatus(job);
  }

  if (job.done) return jobStatus(job);

  const start = job.cursor;
  const end = Math.min(start + Math.max(1, chunkSize), job.total);
  const slice = job.ids.slice(start, end);

  for (const id of slice) {
    try {
      if (job.op === 'update_contact') await ghl.updateContact(id, job.fields);
      else if (job.op === 'add_tags') await ghl.addTagsToContact(id, job.tags);
      else if (job.op === 'remove_tags') await ghl.removeTagsFromContact(id, job.tags);
    } catch (e) {
      job.errors.push({ id, error: String((e && e.message) || e) });
    }
    if (BULK_DELAY_MS) await new Promise(r => setTimeout(r, BULK_DELAY_MS));
  }

  job.cursor = end;
  job.done = job.cursor >= job.total;
  await kvSet(`bulk:${jobId}`, job, { ex: TTL });
  return jobStatus(job);
}

function bulkQueuedMessage(job) {
  const count = job.total == null ? 'the matching' : job.total;
  if (job.total === 0) return 'No matching contacts found, nothing to change.';
  if (job.op === 'update_contact') {
    return `Queued an update for ${count} contacts. Processing now — watch the progress bar below.`;
  }
  const mode = job.op === 'remove_tags' ? 'remove tag(s) from' : 'add tag(s) to';
  return `Queued ${mode} ${count} contacts. Processing now — watch the progress bar below.`;
}

module.exports = {
  createBulkJob,
  processBulkJob,
  resolveAll,
  resolveTargets,
  kvAvailable,
  bulkQueuedMessage,
  BULK_DEFAULT_CHUNK,
  BULK_DELAY_MS,
};
