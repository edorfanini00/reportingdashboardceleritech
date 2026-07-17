// Maps a GoHighLevel webhook payload into the dashboard "lead" structure.
// Kept dependency-free so it can be unit-tested with plain node.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Precise, FDA-aware mapping from dashboard "details" keys to the exact GHL
// custom-field names (normalized). Meta-campaign leads use the `meta` list;
// FDA-campaign leads prefer the `fda` list first. Matched by exact normalized
// name, so gating questions like "Do you have an estimated budget?" are ignored.
const DETAIL_FIELDS = {
  companyDesc: {
    meta: ['which best describes your company', 'company description', 'what industry do you operate in', 'organization type', 'organization type oil and gas'],
    fda: ['company description fda', 'which best describes your company'],
  },
  challenge: {
    meta: ['what is your biggest operational challenge right now', 'operational challenge'],
    fda: ['biggest compliance concern', 'what is your biggest operational challenge right now'],
  },
  software: {
    meta: ['do you currently use any software to manage production inventory or logistics', 'do you currently use any software', 'current software oil', 'current software oil and gas', 'what software are you currently using'],
    fda: ['how they are currently managing compliance records', 'do you currently use any software'],
  },
  timeline: {
    meta: ['timeline', 'timeline oil and gas'],
    fda: ['timeline fda', 'timeline'],
  },
  budget: {
    meta: ['budget'],
    fda: ['budget'],
  },
  employees: {
    meta: ['number of employees', 'how many employees are working in the company', 'number of entities'],
    fda: ['number of employees fda', 'number of employees'],
  },
  role: {
    meta: ['role in the company', 'role', 'role in the company oil and gas'],
    fda: ['role fda', 'role in the company', 'role'],
  },
  website: {
    meta: ['website'],
    fda: ['website'],
  },
  foodType: {
    meta: ['producto que te interesa'],
    fda: [],
  },
  city: {
    meta: ["city you're located in"],
    fda: ["city you're located in"],
  },
};

// Values that are clearly GHL internal ids (no spaces, long alphanumeric) should
// never populate a human-facing detail field.
function looksLikeId(value) {
  const s = String(value).trim();
  return /^[A-Za-z0-9]{18,}$/.test(s) && !/\s/.test(s);
}

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

// Meta-sourced leads in GoHighLevel are tagged "meta lead" / "meta lead fda"
// (and an "fda" tag). Oil & gas campaign leads carry "oil and gas" /
// "meta oil and gas lead". Metodo campaign leads carry "metodo campaign" /
// "metodo alimentacion" / "metodo oil&gas campaign" / "metodo contenedores".
// Miami neighborhood (USA) campaign leads carry "en miami neighborhoods" /
// "es miami neighborhood".
//
// The metodo tags also cover email + Instagram DM outreach; the report only
// tracks the Facebook ad leads, so metodo-tagged contacts qualify ONLY when
// their GHL source is a Facebook campaign (e.g. "Facebook - Metodo
// Alimentacion", "Facebook - Metodo Petroleo").
function hasQualifyingTag(tags, source) {
  const normalized = normalizeTags(tags);
  const has = (s) => normalized.some(t => t.includes(s));
  if (has('metodo') && !has('miami neighborhood')) {
    return String(source || '').toLowerCase().includes('facebook');
  }
  return normalized.some(t => t.includes('meta') || t.includes('fda') || t.includes('oil') || t.includes('miami neighborhood'));
}

// The GHL contact "source" names the exact ad campaign (e.g. "Facebook -
// Metodo Petroleo", "Facebook - Food Manufacturer", "Facebook - Miami
// neighborhood ES"). When it matches a known campaign it beats the tags.
function pipelineFromSource(source) {
  const s = String(source || '').toLowerCase();
  if (!s.includes('facebook')) return null;
  if (s.includes('miami')) return 'Miami Neighborhood';
  if (s.includes('metodo alimentacion')) return 'Metodo Alimentacion';
  if (s.includes('metodo petroleo')) return 'Metodo Oil & Gas';
  if (s.includes('metodo contenedores')) return 'Metodo Contenedores';
  if (s.includes('metodo')) return 'Metodo';
  if (s.includes('food manufacturer')) return 'Food Manufacturer';
  if (s.includes('fda')) return 'FDA';
  if (s.includes('oil')) return 'Oil & Gas';
  return null;
}

// Returns the dashboard pipeline/category. The GHL source wins when it names
// a campaign; otherwise fall back to tags. Miami neighborhood is checked
// before metodo (it's a distinct USA campaign even when the contact also
// carries a metodo tag), and metodo before "oil" so "metodo oil&gas campaign"
// doesn't fall into the Meta "Oil & Gas" bucket.
function pipelineFromTags(tags, source) {
  const bySource = pipelineFromSource(source);
  if (bySource) return bySource;
  const normalized = normalizeTags(tags);
  const has = (s) => normalized.some(t => t.includes(s));
  if (has('miami neighborhood')) return 'Miami Neighborhood';
  if (has('metodo')) {
    if (has('alimentacion')) return 'Metodo Alimentacion';
    if (has('oil')) return 'Metodo Oil & Gas';
    if (has('contenedores')) return 'Metodo Contenedores';
    return 'Metodo';
  }
  if (has('oil')) return 'Oil & Gas';
  if (has('fda')) return 'FDA';
  if (has('food manufacturer')) return 'Food Manufacturer';
  if (has('meta')) return 'Meta Lead';
  return 'General';
}

// Flatten a GHL payload into a single key/value bag of candidate fields,
// merging top-level fields, customData, and various custom-field shapes.
// customFieldMap (id -> { name, fieldKey }) resolves API custom fields that
// only carry an internal id.
function flattenPayload(payload, customFieldMap) {
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
  // GHL API search returns nested contact; webhook may send flat body.
  if (payload.contact && typeof payload.contact === 'object') {
    const c = payload.contact;
    assign({ firstName: c.firstName, lastName: c.lastName, email: c.email, phone: c.phone, companyName: c.companyName, tags: c.tags, dateAdded: c.dateAdded, id: c.id });
  }
  const cf = payload.customFields || payload.custom_fields || payload.customField
    || (payload.contact && (payload.contact.customFields || payload.contact.customField));
  if (Array.isArray(cf)) {
    cf.forEach(f => {
      const value = f.value !== undefined ? f.value : (f.field_value !== undefined ? f.field_value : f.fieldValue);
      // Prefer human-readable keys; fall back to resolving the id via the map.
      let key = f.name || f.key || f.fieldKey;
      const resolved = (f.id && customFieldMap && customFieldMap[f.id]) || null;
      if (resolved) {
        if (resolved.name) bag[resolved.name] = value;
        if (resolved.fieldKey) bag[resolved.fieldKey] = value;
        key = key || resolved.name || resolved.fieldKey;
      }
      if (key) bag[key] = value;
      else if (f.id) bag[f.id] = value;
    });
  } else if (cf && typeof cf === 'object') {
    assign(cf);
  }
  return bag;
}

// Normalize a key for fuzzy matching: lowercase, strip a leading "contact."
// and turn underscores/dots/dashes into spaces.
function normalizeKey(k) {
  return String(k)
    .toLowerCase()
    .replace(/^contact\./, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Clean up the free-text "Status" custom field the setters type by hand.
// Maps typos/variants ("no asnwer", "nuture", "interesado", "call back |")
// onto a small canonical set so the dashboard can count them reliably.
function normalizeCallStatus(raw) {
  const s = String(raw || '').trim().toLowerCase().replace(/[|·]+$/g, '').trim();
  if (!s) return '';
  if (s.includes('book')) return 'booked';
  if (s.includes('no answer') || s.includes('no asnwer')) return 'no answer';
  if (s.includes('answer')) return 'answered';
  if (s.includes('not interested')) return 'not interested';
  if (s.includes('interes')) return 'interested'; // interested / interesado
  if (s.includes('call back') || s.includes('callback')) return 'call back';
  if (s.includes('nurtur') || s.includes('nuture')) return 'nurture';
  if (s.includes('abandon')) return 'abandon';
  if (s.includes('unqualified') || s.includes('disqualified')) return 'not qualified';
  if (s === 'new') return 'new';
  return s;
}

// Build the lead.details object using exact, FDA-aware field-name matching.
function extractDetails(bag, isFda) {
  const details = {};
  // normalized field name -> value (skip empties and id-like values)
  const byName = {};
  for (const [k, v] of Object.entries(bag)) {
    if (v === undefined || v === null || String(v).trim() === '') continue;
    if (looksLikeId(v)) continue;
    const nk = normalizeKey(k);
    if (!(nk in byName)) byName[nk] = String(v);
  }
  for (const [detailKey, cfg] of Object.entries(DETAIL_FIELDS)) {
    const candidates = isFda ? cfg.fda : cfg.meta;
    for (const cand of candidates) {
      if (byName[cand] !== undefined) { details[detailKey] = byName[cand]; break; }
    }
  }
  return details;
}

function formatDisplayDate(d) {
  return MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate();
}

// Main transform: GHL payload -> dashboard lead object.
function transformContact(payload, customFieldMap) {
  const bag = flattenPayload(payload, customFieldMap);
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

  const ghlSource = pick(bag, ['source', 'contact_source', 'contactSource']) || '';
  const pipeline = pipelineFromTags(tags, ghlSource);
  const details = extractDetails(bag, pipeline === 'FDA');

  // The "Status" custom field tracks the call outcome (booked / call back /
  // no answer / not interested / interested / nurture / abandon / new).
  const callStatus = normalizeCallStatus(pick(bag, ['contact.status', 'Status', 'status']));

  // Show the real GHL campaign source (e.g. "Facebook - Metodo Alimentacion")
  // when present; fall back to a sensible label per pipeline.
  const fallbackSource = pipeline === 'Miami Neighborhood' ? 'Miami Neighborhood'
    : (pipeline.startsWith('Metodo') ? 'Metodo' : 'Meta ads');

  const lead = {
    id: String(contactId),
    name,
    source: String(ghlSource).trim() || fallbackSource,
    pipeline,
    date: formatDisplayDate(d),
    dateISO,
    email,
    business,
    phone,
    tags
  };
  if (callStatus) lead.callStatus = callStatus;
  // Booked when the Status field says so OR the contact carries the tag.
  if (callStatus === 'booked' || tags.some(t => t.includes('meeting booked'))) lead.meetingBooked = true;
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
