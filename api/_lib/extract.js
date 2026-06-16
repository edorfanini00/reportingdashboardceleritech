// Pull candidate contacts out of free-text email bodies.
//
// John writes the people he wants us to reach out to in the email body. There is
// no fixed template, so we extract the reliable identifiers (email, phone) with
// regex and best-effort a name/company near each one. Email/phone are treated as
// high-confidence match keys; name/company are advisory only.

const EMAIL_RE = /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi;

// Phone: 10-15 digits allowing +, spaces, dashes, dots, parens. Requires enough
// digits to avoid matching prices/years.
const PHONE_RE = /(?:\+?\d[\d().\- \t]{8,16}\d)/g;

// Domains that are mail providers, not companies.
const FREE_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com',
  'aol.com', 'live.com', 'msn.com', 'protonmail.com', 'me.com', 'comcast.net',
]);

function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}

function titleCaseFromDomain(domain) {
  const core = domain.split('.')[0];
  if (!core) return '';
  return core.charAt(0).toUpperCase() + core.slice(1);
}

// Look backwards from a position for a "Firstname Lastname" style name on the
// same or previous line (common in "John Smith john@acme.com" or "Name: ...").
const TITLE_WORDS = /\b(CEO|CFO|CTO|COO|CIO|President|VP|Founder|Owner|Director|Manager|Officer|Chief|Head|Inc|LLC|Ltd|Corp|Company|Co|Group|Systems|Solutions|Salt|Wines|Lighting|Media|Roofing|Electromechanics)\b/i;
const NAME_LIKE = /^[A-Z][a-zA-Z'’.\-]+(?:\s+[A-Z][a-zA-Z'’.\-]+){1,2}$/;

function guessNameNear(text, index) {
  const before = text.slice(Math.max(0, index - 160), index);
  const labeled = before.match(/(?:name|contact|attn)\s*[:\-]\s*([A-Z][a-zA-Z'’.\-]+(?:\s+[A-Z][a-zA-Z'’.\-]+){0,3})\s*$/i);
  if (labeled) return labeled[1].trim();

  // "reach out to Ben Dennis" / "contact Ben Dennis"
  const verb = before.match(/(?:reach out to|contact|add|for|prospect[oa]?:?)\s+([A-Z][a-zA-Z'’.\-]+(?:\s+[A-Z][a-zA-Z'’.\-]+){1,2})/i);
  if (verb && !TITLE_WORDS.test(verb[1])) return verb[1].trim();

  // Walk preceding lines, prefer a clean "First Last" with no title/company words.
  const lines = before.split('\n').map(l => l.replace(/[,(<\-]+$/, '').trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const candidate = lines[i].replace(/^.*?(?:reach out to|contact|add|for)\s+/i, '').trim();
    if (NAME_LIKE.test(candidate) && !TITLE_WORDS.test(candidate)) return candidate;
  }
  const trailing = before.match(/([A-Z][a-zA-Z'’.\-]+(?:\s+[A-Z][a-zA-Z'’.\-]+){1,2})[\s,(<\-]*$/);
  if (trailing && !TITLE_WORDS.test(trailing[1])) return trailing[1].trim();
  return '';
}

function guessCompanyNear(text, index, emailDomain) {
  const window = text.slice(Math.max(0, index - 120), index + 40);
  const labeled = window.match(/(?:company|business|organization|org|firm)\s*[:\-]\s*([A-Z0-9][^\n,;]{1,60})/i);
  if (labeled) return labeled[1].trim();
  if (emailDomain && !FREE_DOMAINS.has(emailDomain.toLowerCase())) {
    return titleCaseFromDomain(emailDomain);
  }
  return '';
}

// Expand to the contact "block" — the paragraph bounded by blank lines around
// the email. John writes labeled fields (Contact/Title/Company/Address/Phone)
// on separate lines with the email at the bottom, so we need the whole block.
function blockAround(text, index, len) {
  const before = text.slice(0, index);
  const after = text.slice(index + len);
  const bMatches = [...before.matchAll(/\n[ \t]*\n/g)];
  const last = bMatches.length ? bMatches[bMatches.length - 1] : null;
  const start = last ? last.index + last[0].length : Math.max(0, index - 400);
  const aMatch = after.match(/\n[ \t]*\n/);
  const end = aMatch ? index + len + aMatch.index : Math.min(text.length, index + len + 200);
  return text.slice(start, end);
}

// Grab a few lines of context around a position — this is the most useful raw
// material for the GHL note, since John writes free-text detail near each lead.
function snippetAround(text, index, len) {
  let start = index;
  let nl = 0;
  while (start > 0 && nl < 3) { start--; if (text[start] === '\n') nl++; }
  let end = index + len;
  nl = 0;
  while (end < text.length && nl < 3) { if (text[end] === '\n') nl++; end++; }
  return text.slice(start, end).replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
}

// Pull a labeled field (e.g. "Title: CFO") from a window of text.
function labeledField(window, names) {
  const re = new RegExp('(?:' + names.join('|') + ')\\s*[:\\-]\\s*([^\\n]{1,80})', 'i');
  const m = window.match(re);
  return m ? m[1].trim().replace(/[,;.]+$/, '') : '';
}

const URL_RE = /(?:https?:\/\/|www\.)[a-z0-9.\-]+\.[a-z]{2,}(?:\/[^\s)]*)?/i;
// Best-effort US street address: "123 Main St, City, ST 12345".
const ADDR_RE = /\d{1,6}[ \t]+[A-Za-z0-9.\- ]+(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Ct|Court|Pl|Place|Suite|Ste|Unit|Fl|Floor)\b[^\n]*/i;

function guessTitleNear(window) {
  const labeled = labeledField(window, ['title', 'role', 'position', 'cargo', 'puesto']);
  if (labeled) return labeled;
  const m = window.match(/\b(CEO|CFO|CTO|COO|CIO|President|Vice President|VP|Founder|Co-?Founder|Owner|Director|Manager|Head of [A-Za-z ]{2,30}|Chief [A-Za-z ]{2,30} Officer)\b/i);
  return m ? m[0].trim() : '';
}

function parseAddress(window) {
  const labeled = labeledField(window, ['address', 'direccion', 'dirección', 'location']);
  const raw = labeled || (window.match(ADDR_RE) || [])[0] || '';
  if (!raw) return {};
  const out = { address1: raw.trim() };
  // City, ST ZIP  (ZIP allowed 4-5 digits since John's emails sometimes typo them)
  const m = raw.match(/,\s*([A-Za-z .'\-]{2,40}),\s*([A-Z]{2})\s*(\d{4,5}(?:-\d{4})?)/);
  if (m) {
    out.city = m[1].trim();
    out.state = m[2].trim();
    out.postalCode = m[3].trim();
    out.address1 = raw.slice(0, raw.indexOf(m[0])).trim() || raw.trim();
  }
  return out;
}

// Extract contacts from a single email body. Anchors on email addresses first
// (most reliable), then sweeps up phone numbers that weren't tied to an email.
function extractFromBody(text, meta = {}) {
  if (!text) return [];
  const found = [];
  const seenEmails = new Set();
  const senderDomain = (meta.from || '').split('@')[1] || '';

  let m;
  EMAIL_RE.lastIndex = 0;
  while ((m = EMAIL_RE.exec(text))) {
    const email = m[0].toLowerCase();
    const domain = email.split('@')[1] || '';
    // Skip John's own address and obvious noise.
    if (domain && senderDomain && domain === senderDomain) continue;
    if (seenEmails.has(email)) continue;
    seenEmails.add(email);

    const block = blockAround(text, m.index, m[0].length);
    const tail = text.slice(m.index + m[0].length, m.index + m[0].length + 60);

    // Prefer explicitly labeled fields from John's block format.
    const nameLabeled = labeledField(block, ['contact', 'name', 'attn', 'contacto', 'nombre']);
    const companyLabeled = labeledField(block, ['company', 'business', 'organization', 'org', 'firm', 'empresa']);
    const phoneLabeled = labeledField(block, ['phone', 'tel', 'telephone', 'mobile', 'cell', 'telefono', 'teléfono']);
    const phoneNear = (String(phoneLabeled).match(PHONE_RE) || [])[0]
      || (tail.match(PHONE_RE) || [])[0]
      || (block.match(PHONE_RE) || [])[0];
    const websiteMatch = block.match(URL_RE);
    const addr = parseAddress(block);

    found.push({
      email,
      phone: phoneNear ? normalizePhone(phoneNear) : '',
      name: nameLabeled || guessNameNear(text, m.index),
      company: companyLabeled || guessCompanyNear(text, m.index, domain),
      title: guessTitleNear(block),
      website: websiteMatch ? websiteMatch[0] : '',
      address1: addr.address1 || '',
      city: addr.city || '',
      state: addr.state || '',
      postalCode: addr.postalCode || '',
      context: snippetAround(text, m.index, m[0].length),
      source: { subject: meta.subject, receivedDateTime: meta.receivedDateTime },
    });
  }

  // Phone numbers with no email anchor: keep as phone-only candidates.
  const emailSpans = [];
  EMAIL_RE.lastIndex = 0;
  while ((m = EMAIL_RE.exec(text))) emailSpans.push([m.index, m.index + m[0].length]);
  const nearEmail = (idx) => emailSpans.some(([s, e]) => idx >= s - 60 && idx <= e + 60);

  const seenPhones = new Set(found.map(f => f.phone).filter(Boolean));
  PHONE_RE.lastIndex = 0;
  while ((m = PHONE_RE.exec(text))) {
    const phone = normalizePhone(m[0]);
    if (phone.length < 10) continue;
    if (nearEmail(m.index)) continue;
    if (seenPhones.has(phone)) continue;
    seenPhones.add(phone);
    found.push({
      email: '',
      phone,
      name: guessNameNear(text, m.index),
      company: '',
      title: '',
      website: '',
      address1: '', city: '', state: '', postalCode: '',
      context: snippetAround(text, m.index, m[0].length),
      source: { subject: meta.subject, receivedDateTime: meta.receivedDateTime },
    });
  }

  return found;
}

// Build a readable note from the email subject/date and the surrounding context.
function buildNote(c) {
  const parts = [];
  const subj = c.source && c.source.subject;
  const date = c.source && c.source.receivedDateTime;
  if (subj || date) {
    parts.push(`From John's email${subj ? `: "${subj}"` : ''}${date ? ` (${String(date).slice(0, 10)})` : ''}`);
  }
  if (c.context) parts.push(c.context);
  return parts.join('\n').trim();
}

// Extract across many messages and dedupe by email||phone.
function extractFromMessages(messages) {
  const byKey = new Map();
  for (const msg of messages) {
    const contacts = extractFromBody(msg.bodyText, {
      from: msg.from,
      subject: msg.subject,
      receivedDateTime: msg.receivedDateTime,
    });
    for (const c of contacts) {
      const key = c.email || c.phone;
      if (!key) continue;
      const note = buildNote(c);
      const existing = byKey.get(key);
      if (existing) {
        // Merge: prefer non-empty fields, accumulate distinct notes.
        existing.phone = existing.phone || c.phone;
        existing.name = existing.name || c.name;
        existing.company = existing.company || c.company;
        existing.title = existing.title || c.title;
        existing.website = existing.website || c.website;
        existing.address1 = existing.address1 || c.address1;
        existing.city = existing.city || c.city;
        existing.state = existing.state || c.state;
        existing.postalCode = existing.postalCode || c.postalCode;
        if (note && !existing._notes.includes(note)) existing._notes.push(note);
      } else {
        c._notes = note ? [note] : [];
        byKey.set(key, c);
      }
    }
  }
  return [...byKey.values()].map(c => {
    const { _notes, context, source, ...rest } = c;
    return { ...rest, notes: (_notes || []).join('\n\n') };
  });
}

// Generate typo-corrected variants of an email (bad TLDs / stray trailing char).
function emailVariants(email) {
  if (!email || !email.includes('@')) return [];
  const [local, domain] = email.split('@');
  const out = new Set();
  if (/\.com[a-z]$/.test(domain)) out.add(`${local}@${domain.replace(/\.com[a-z]$/, '.com')}`);
  if (/\.(con|cim|ocm|vom|xom|cpm|comm)$/.test(domain)) {
    out.add(`${local}@${domain.replace(/\.(con|cim|ocm|vom|xom|cpm|comm)$/, '.com')}`);
  }
  out.delete(email);
  return [...out];
}

module.exports = { extractFromBody, extractFromMessages, normalizePhone, emailVariants, EMAIL_RE, PHONE_RE };
