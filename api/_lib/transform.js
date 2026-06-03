// Maps a GoHighLevel webhook payload into the dashboard "lead" structure.
// Kept dependency-free so it can be unit-tested with plain node.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Fuzzy mapping from the dashboard "details" keys to substrings that may appear
// in a GHL custom-field label/key. First match wins. Edit freely as your forms change.
const DETAIL_FIELD_MAP = {
  companyDesc: ['company description', 'which best describes', 'best describes your', 'business type', 'type of business', 'company_desc', 'companydesc', 'describe your company', 'industry'],
  challenge: ['challenge', 'biggest pain', 'pain point', 'struggling', 'problem you', 'main issue'],
  software: ['current software', 'software', 'current system', 'currently using', 'erp', 'manage your', 'what system'],
  timeline: ['timeline', 'time frame', 'timeframe', 'how soon', 'when do you', 'deadline', 'looking to start'],
  budget: ['budget', 'investment', 'spend'],
  employees: ['employees', 'team size', 'how many people', 'number of employees', 'headcount', 'staff'],
  role: ['role', 'your position', 'job title', 'title at', 'what is your role'],
  website: ['website', 'web site', 'company url', 'site url', 'url'],
  foodType: ['type of food', 'food type', 'what do you make', 'what do you produce', 'product type', 'what products'],
  city: ['city', 'location', 'address', 'where are you']
};

function pick(obj, keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== '') return obj[k];
  }
  return undefined;
}

// Normalize a tags value (array or comma-separated string) into a lowercased array.
function normalizeTags(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(t => String(t).trim().toLowerCase()).filter(Boolean);
  return String(raw).split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
}

// Only contacts tagged "meta" or "meta fda" in GoHighLevel should sync.
function hasQualifyingTag(tags) {
  const normalized = normalizeTags(tags);
  return normalized.some(t => t === 'meta' || t === 'meta fda');
}

// Returns 'FDA' / 'Meta Lead' / 'General' based on tags.
function pipelineFromTags(tags) {
  const normalized = normalizeTags(tags);
  if (normalized.some(t => t === 'meta fda')) return 'FDA';
  if (normalized.some(t => t === 'meta')) return 'Meta Lead';
  return 'General';
}

// Flatten a GHL payload into a single key/value bag of candidate fields,
// merging top-level fields, customData, and various custom-field shapes.
function flattenPayload(payload) {
  const bag = {};
  const assign = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      if (v === null || v === undefined) continue;
      if (typeof v === 'object' && !Array.isArray(v)) continue;
      bag[k] = v;
    }
  };
  assign(payload);
  assign(payload.customData);
  assign(payload.contact);
  // customFields can be an array of { id/key/name, value } or an object map.
  const cf = payload.customFields || payload.custom_fields || (payload.contact && payload.contact.customFields);
  if (Array.isArray(cf)) {
    cf.forEach(f => {
      const key = f.name || f.key || f.id;
      if (key) bag[key] = f.value !== undefined ? f.value : f.field_value;
    });
  } else if (cf && typeof cf === 'object') {
    assign(cf);
  }
  return bag;
}

// Build the lead.details object by fuzzy-matching all flattened fields.
function extractDetails(bag) {
  const details = {};
  const entries = Object.entries(bag).map(([k, v]) => [String(k).toLowerCase(), k, v]);
  for (const [detailKey, fragments] of Object.entries(DETAIL_FIELD_MAP)) {
    for (const [lk, , value] of entries) {
      if (value === undefined || value === null || String(value).trim() === '') continue;
      if (fragments.some(fr => lk.includes(fr))) { details[detailKey] = String(value); break; }
    }
  }
  return details;
}

function formatDisplayDate(d) {
  return MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate();
}

// Main transform: GHL payload -> dashboard lead object.
function transformContact(payload) {
  const bag = flattenPayload(payload);
  const tags = normalizeTags(pick(bag, ['tags', 'tag']) || payload.tags);

  const first = pick(bag, ['first_name', 'firstName', 'firstname']) || '';
  const last = pick(bag, ['last_name', 'lastName', 'lastname']) || '';
  const name = pick(bag, ['full_name', 'fullName', 'contact_name', 'name'])
    || `${first} ${last}`.trim()
    || pick(bag, ['email']) || 'Unknown Lead';

  const email = pick(bag, ['email', 'contact_email']) || 'Not Provided';
  const phone = pick(bag, ['phone', 'phone_number', 'contact_phone']) || '--';
  const business = pick(bag, ['company_name', 'companyName', 'business', 'business_name', 'organization']) || 'Unknown';

  const rawDate = pick(bag, ['date_created', 'dateAdded', 'date_added', 'createdAt', 'created_at', 'dateCreated']);
  const dateObj = rawDate ? new Date(rawDate) : new Date();
  const dateISO = (isNaN(dateObj.getTime()) ? new Date() : dateObj).toISOString();
  const d = new Date(dateISO);

  const contactId = pick(bag, ['contact_id', 'contactId', 'id']) || email || name;

  const details = extractDetails(bag);

  const lead = {
    id: String(contactId),
    name,
    source: 'Meta ads',
    pipeline: pipelineFromTags(tags),
    date: formatDisplayDate(d),
    dateISO,
    email,
    business,
    phone,
    tags
  };
  if (Object.keys(details).length > 0) lead.details = details;
  return lead;
}

// Week-key helpers (Sunday-start weeks) matching the dashboard's 'mon-dd' scheme.
function weekKeyFor(dateISO) {
  const d = new Date(dateISO);
  const day = d.getUTCDay();
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
  const mon = MONTHS[start.getUTCMonth()].toLowerCase();
  return `${mon}-${String(start.getUTCDate()).padStart(2, '0')}`;
}

module.exports = { transformContact, weekKeyFor, normalizeTags, pipelineFromTags, hasQualifyingTag, MONTHS };
