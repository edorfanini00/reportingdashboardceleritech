// Stateless bulk-action helpers for the AI assistant and Quick bulk panel.
//
// Large CRM operations (e.g. "set source for all 200 contacts with tag X")
// can't run in one serverless request without timing out. The job "state"
// (the id list and a cursor) is held by the DASHBOARD, which drives many
// small /api/bulk requests: first `resolve` pages to find the target ids,
// then `process` chunks that update a few contacts each — slowly, one by
// one, with a per-contact success/error result so everything is verified.
// No database is required for any of this.
const ghl = require('./ghl-client');

const VALID_OPS = ['update_contact', 'add_tags', 'remove_tags'];

// GHL burst limit ≈ 100 requests / 10s per location. Process one contact at a
// time with a pause between each so bulk jobs complete without 429s.
const BULK_DELAY_MS = 600; // ~1.6 contacts/sec — well under the burst ceiling
const MAX_CHUNK = 10;      // max contacts per /api/bulk process request
const RESOLVE_PAGE_LIMIT = 100;

function filterByAllTags(contacts, allTags) {
  if (!Array.isArray(allTags) || allTags.length <= 1) return contacts;
  const required = allTags.map(t => String(t).toLowerCase());
  return contacts.filter(c => {
    const cTags = (c.tags || []).map(t => String(t).toLowerCase());
    return required.every(r => cTags.includes(r));
  });
}

// A job targets contacts by tag, by raw advanced filters (how a Smart List is
// reproduced), or by an explicit id list. Tag targeting is just the simplest
// filter, so both paths share one resolver.
function jobFilters(spec) {
  if (Array.isArray(spec.filters) && spec.filters.length) return spec.filters;
  if (spec.tag) return ghl.tagFilters(spec.tag);
  return null;
}

// One page of target resolution. `done` tells the caller to stop paging.
async function resolveTargetPage(spec, page) {
  const filters = jobFilters(spec);
  if (!filters && !spec.query) throw new Error('Nothing to resolve: no tag, filters, or contact ids.');
  const { batch, total } = await ghl.searchFilterPage({
    filters,
    query: spec.query,
    page,
    pageLimit: RESOLVE_PAGE_LIMIT,
  });
  const filtered = filterByAllTags(batch, spec.allTags);
  return {
    ids: filtered.map(c => c.id).filter(Boolean),
    total: total == null ? null : total,
    done: batch.length < RESOLVE_PAGE_LIMIT,
  };
}

// Kept for older cached clients that still call resolve with a bare tag.
async function resolveTagPage(tag, page, allTags) {
  const { ids, done } = await resolveTargetPage({ tag, allTags }, page);
  return { ids, done };
}

// How many contacts a job will touch, before it touches any of them.
async function countTargets(spec) {
  const filters = jobFilters(spec);
  if (!filters && !spec.query) return null;
  return ghl.countContacts({ filters, query: spec.query });
}

// Preflight a job's payload ONCE, before the run. Resolves owner names to user
// ids and rejects unknown fields here, so a bad request fails loudly up front
// instead of silently failing on every one of hundreds of contacts.
async function validateJob(op, { fields, tags } = {}) {
  if (!VALID_OPS.includes(op)) throw new Error(`Unsupported bulk op: ${op || '(missing)'}`);
  if (op === 'update_contact') {
    if (!fields || !Object.keys(fields).length) throw new Error('No fields given to update.');
    const resolved = await ghl.normalizeContactFields(fields);
    const notes = [];
    if (fields.assignedTo || fields.owner || fields.assignedOwner) {
      const asked = fields.assignedTo || fields.owner || fields.assignedOwner;
      if (resolved.assignedTo && resolved.assignedTo !== asked) {
        const user = await ghl.resolveUser(resolved.assignedTo);
        notes.push(`Owner "${asked}" resolved to ${user.name} (${user.id})`);
      }
    }
    return { op, fields: resolved, notes };
  }
  const list = (Array.isArray(tags) ? tags : [tags]).filter(Boolean);
  if (!list.length) throw new Error('No tag(s) given.');
  return { op, tags: list, notes: [] };
}

// Apply the op to each contact sequentially (rate-limit safe), returning a
// per-contact result so the caller can verify and retry failures.
async function processChunk(op, ids, { fields, tags }) {
  const results = [];
  for (const id of ids) {
    try {
      if (op === 'update_contact') await ghl.updateContact(id, fields);
      else if (op === 'add_tags') await ghl.addTagsToContact(id, tags);
      else if (op === 'remove_tags') await ghl.removeTagsFromContact(id, tags);
      results.push({ id, ok: true });
    } catch (e) {
      results.push({ id, ok: false, error: String((e && e.message) || e) });
    }
    if (BULK_DELAY_MS) await new Promise(r => setTimeout(r, BULK_DELAY_MS));
  }
  return results;
}

function bulkQueuedMessage(spec) {
  const count = spec.total == null ? 'the matching' : spec.total;
  if (spec.total === 0) return 'No matching contacts found, nothing to change.';
  if (spec.op === 'update_contact') {
    return `Queued an update for ${count} contacts. Processing now — watch the progress bar below.`;
  }
  const mode = spec.op === 'remove_tags' ? 'remove tag(s) from' : 'add tag(s) to';
  return `Queued ${mode} ${count} contacts. Processing now — watch the progress bar below.`;
}

module.exports = {
  VALID_OPS,
  MAX_CHUNK,
  BULK_DELAY_MS,
  resolveTagPage,
  resolveTargetPage,
  countTargets,
  validateJob,
  processChunk,
  bulkQueuedMessage,
  filterByAllTags,
  jobFilters,
};
