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

function kvAvailable() {
  return Boolean(_kv);
}

// Resolve the list of contact ids a job will act on.
async function resolveTargets({ contactIds, tag, allTags }) {
  if (Array.isArray(contactIds) && contactIds.length) {
    return [...new Set(contactIds.filter(Boolean))];
  }
  if (tag) {
    let results = await ghl.searchByTagEquals(tag);
    if (Array.isArray(allTags) && allTags.length > 1) {
      const required = allTags.map(t => String(t).toLowerCase());
      results = results.filter(c => {
        const cTags = (c.tags || []).map(t => String(t).toLowerCase());
        return required.every(r => cTags.includes(r));
      });
    }
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
    errorCount: job.errors.length,
    errors: job.errors.slice(0, 10),
  };
}

// Create a job: resolve targets, persist to KV, return status (incl. jobId, total).
async function createBulkJob(spec) {
  if (!VALID_OPS.includes(spec.op)) {
    throw new Error(`Unsupported bulk op: ${spec.op}`);
  }
  if (!kvAvailable()) {
    throw new Error('Bulk actions require Vercel KV. Connect a KV store to the project.');
  }
  const ids = await resolveTargets(spec);
  const job = {
    id: crypto.randomUUID(),
    op: spec.op,
    fields: spec.fields || null,
    tags: spec.tags || null,
    ids,
    total: ids.length,
    cursor: 0,
    done: ids.length === 0,
    errors: [],
    createdAt: Date.now(),
  };
  await kvSet(`bulk:${job.id}`, job, { ex: TTL });
  return job;
}

// Process the next `chunkSize` contacts of a job. Safe to call repeatedly.
async function processBulkJob(jobId, chunkSize = 8) {
  const job = await kvGet(`bulk:${jobId}`);
  if (!job) return { error: 'Job not found or expired.' };
  if (job.done) return jobStatus(job);

  const start = job.cursor;
  const end = Math.min(start + Math.max(1, chunkSize), job.total);
  const slice = job.ids.slice(start, end);

  await Promise.all(slice.map(async (id) => {
    try {
      if (job.op === 'update_contact') await ghl.updateContact(id, job.fields);
      else if (job.op === 'add_tags') await ghl.addTagsToContact(id, job.tags);
      else if (job.op === 'remove_tags') await ghl.removeTagsFromContact(id, job.tags);
    } catch (e) {
      job.errors.push({ id, error: String((e && e.message) || e) });
    }
  }));

  job.cursor = end;
  job.done = job.cursor >= job.total;
  await kvSet(`bulk:${jobId}`, job, { ex: TTL });
  return jobStatus(job);
}

module.exports = { createBulkJob, processBulkJob, resolveTargets, kvAvailable };
