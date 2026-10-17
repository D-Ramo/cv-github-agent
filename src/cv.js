import { extractText, getDocumentProxy } from 'unpdf';
import { config } from './config.js';

const RESERVED = new Set([
  'about', 'apps', 'collections', 'contact', 'enterprise', 'explore', 'features', 'issues', 'login', 'marketplace',
  'notifications', 'orgs', 'pricing', 'pulls', 'search', 'security', 'settings', 'site', 'sponsors', 'team', 'topics', 'trending',
]);

export async function pdfToText(buffer) {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}

/**
 * GitHub accounts linked in the CV, most likely to be the applicant's first: profile links
 * (github.com/user) in order, then owners of linked repos, most-linked first. Links to pull
 * requests, issues or commits point at someone else's project the applicant contributed to,
 * so they are ignored.
 * @returns {{login: string, profile: boolean}[]}
 */
export function githubCandidatesFromText(text) {
  const profiles = [];
  const repoOwners = new Map(); // lowercased login -> { login, count }
  const re = /github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))(?![A-Za-z0-9-])(\/[^\s,;)\]>"']*)?/gi;
  for (const m of String(text ?? '').matchAll(re)) {
    const login = m[1];
    const key = login.toLowerCase();
    if (RESERVED.has(key)) continue;
    const rest = (m[2] ?? '').replace(/\/+$/, '');
    if (!rest) {
      if (!profiles.some((p) => p.toLowerCase() === key)) profiles.push(login);
    } else if (!/\/(pulls?|issues|commits?|compare)(\/|$)/i.test(rest)) {
      const o = repoOwners.get(key) ?? { login, count: 0 };
      o.count++;
      repoOwners.set(key, o);
    }
  }
  const seen = new Set(profiles.map((p) => p.toLowerCase()));
  return [
    ...profiles.map((login) => ({ login, profile: true })),
    ...[...repoOwners.values()]
      .filter((o) => !seen.has(o.login.toLowerCase()))
      .sort((a, b) => b.count - a.count) // stable: ties keep their order in the CV
      .map((o) => ({ login: o.login, profile: false })),
  ];
}

// Short words that are also name particles, and names that are also tech words ("AI", "Ray Tune",
// the Julia language). On their own they are never masked or swapped; masking them would garble the CV.
export const NAME_STOPWORDS = new Set(
  'an as at be by do he if in is it me my no of on or so to up us we the and for van von der den de da di du la le el al bin ibn del dos das ai ray julia ruby'.split(' '),
);
export const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Every part capitalised: "anne-marie o'brien" -> "Anne-Marie O'Brien".
export const titleCase = (s) => s.toLowerCase().replace(/(^|[\s'’-])(\p{L})/gu, (_, a, b) => a + b.toUpperCase());

/**
 * Replace the applicant's name and account handles with placeholders so scoring agents
 * cannot see them. The full name is masked first; then each name part on its own. Both match as
 * written, Title-case or UPPER-case only, so common words that happen to be names ("grant", "will")
 * are left alone in running text.
 * @param {string} text
 * @param {{name?: string, handles?: string[]}} identity
 */
export function maskIdentity(text, { name = '', handles = [] } = {}) {
  let t = String(text ?? '');
  for (const h of new Set(handles.filter((x) => x && x.length >= 3).map((x) => x.toLowerCase()))) {
    t = t.replace(new RegExp(`(?<![A-Za-z0-9_-])@?${escapeRe(h)}(?![A-Za-z0-9_-])`, 'gi'), '[user]');
  }
  const words = String(name ?? '')
    .split(/[\s,]+/)
    .map((p) => p.replace(/^[.'’-]+|[.'’-]+$/g, ''))
    .filter(Boolean);
  const phrases = words.length > 1 ? [words] : [];
  for (const p of words) if (p.length >= 2 && !NAME_STOPWORDS.has(p.toLowerCase())) phrases.push([p]);
  for (const ws of phrases) {
    const forms = [...new Set([ws, ws.map(titleCase), ws.map((w) => w.toUpperCase())].map((f) => f.map(escapeRe).join('\\s+')))].join('|');
    t = t.replace(new RegExp(`(?<![\\p{L}\\p{N}])(?:${forms})(?![\\p{L}\\p{N}])`, 'gu'), '[name]');
  }
  // LinkedIn profile slugs are personal by construction (companies live under /company/).
  return t.replace(/(linkedin\.com\/in\/)[^\s/?#,;)]+/gi, '$1[user]');
}

const isYear = (g) => /^(19|20)\d\d$/.test(g);

/**
 * Whether a run of digits and separators is a phone number rather than dates or scores,
 * e.g. "+31 6 1234 5678" or "(202) 555-0143", but not "3.8 (2019 - 2023)" or "2018 - 2022 2022 - 2024".
 */
function looksLikePhone(m) {
  const digits = m.replace(/\D/g, '');
  if (digits.length < 9 || digits.length > 15) return false; // E.164 numbers have at most 15 digits
  if (m.trimStart().startsWith('+')) return true;
  if (/(^|\D)\d{1,2}\.\d/.test(m)) return false; // decimals: GPA 3.8, accuracy 0.91, dates like 12.2019
  const groups = m.match(/\d+/g);
  return !(groups.some(isYear) && groups.every((g) => isYear(g) || g.length <= 2)); // year ranges
}

/** Replace email addresses and phone numbers with placeholders. Also safe on raw PDF text. */
export function maskContacts(text) {
  return String(text ?? '')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/\+?\(?\d[\d (). -]{7,}\d/g, (m) => (looksLikePhone(m) ? '[phone]' : m));
}

/**
 * Normalise whitespace, mask contact details and identity (fewer tokens, less PII sent to the model)
 * and cap the length to the CV budget.
 * @param {string} raw
 * @param {{name?: string, handles?: string[]}} [identity] the applicant's entered name and GitHub handles
 */
export function prepareCv(raw, identity = {}) {
  let t = String(raw ?? '')
    .replace(/\r/g, '')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  t = maskIdentity(maskContacts(t), identity);

  const chars = t.length;
  return { text: fitBudget(t, config.budgets.cvChars), truncated: chars > config.budgets.cvChars, chars };
}

/**
 * Shrink a long CV without losing whole sections: first shorten very long lines,
 * then cut from the middle, because certifications, courses and extracurriculars
 * usually sit at the end and education/summary at the start.
 */
function fitBudget(t, max) {
  if (t.length <= max) return t;
  t = t
    .split('\n')
    .map((l) => (l.length > 260 ? l.slice(0, 260) + '…' : l))
    .join('\n');
  if (t.length <= max) return t;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return `${t.slice(0, head)}\n…[middle of CV omitted for length]…\n${t.slice(-tail)}`;
}
