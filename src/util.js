import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function clip(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + ' …[truncated]' : s;
}

export function clamp(n, lo = 0, hi = 10) {
  n = Number(n);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
}

/** Normalise a model-returned list: array, non-empty, max n items, strings clipped. */
export function list(v, n, len = 160) {
  return (Array.isArray(v) ? v : [])
    .filter((x) => x != null && x !== '')
    .slice(0, n)
    .map((x) => (typeof x === 'string' ? clip(x, len) : x));
}

export const oneOf = (v, options, fallback) => (options.includes(v) ? v : fallback);

export function readJsonFile(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function writeJsonFile(p, v) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(v));
}

export function appendJsonl(p, v) {
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify(v) + '\n');
}

export function readJsonl(p) {
  let text;
  try {
    text = readFileSync(p, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip a partially written line
    }
  }
  return out;
}

/** Latest successful result per applicant id, highest score first. */
export function latestResults(p) {
  const byId = new Map();
  for (const r of readJsonl(p)) if (r && r.id && !r.error) byId.set(r.id, r);
  return [...byId.values()].sort((a, b) => b.agent_score - a.agent_score);
}

/** Minimal concurrency limiter: limit(fn) runs fn when a slot is free. */
export function pLimit(n) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= n || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active--;
        next();
      });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}
