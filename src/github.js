import { join } from 'node:path';
import { config } from './config.js';
import { clip, readJsonFile, sleep, writeJsonFile } from './util.js';

const API = 'https://api.github.com';
const YEAR = 365 * 864e5;
// Bump when the digest or the stored fields change, so cached profiles are rebuilt.
const CACHE_VERSION = 3;

const AI_RE =
  /\b(ai|ml|llms?|gpt|rag|agents?|agentic|nlp|neural|deep[- ]?learning|machine[- ]?learning|transformers?|pytorch|torch|tensorflow|keras|sklearn|scikit|langchain|langgraph|llama|openai|anthropic|claude|gemini|hugging ?face|diffusion|embeddings?|vector|vision|yolo|bert|fine[- ]?tun\w*|reinforcement|classifier|chatbot|kaggle)\b/i;
const LOW_SIGNAL_RE =
  /(^|[-_.])(hello[-_]?world|tutorial|course|homework|assignment|exercises?|practice|bootcamp|dotfiles|leetcode|100[-_]?days|spoon[-_]?knife)([-_.]|$)|\.github\.io$|^\.github$/i;
const MANIFESTS = ['requirements.txt', 'pyproject.toml', 'environment.yml', 'package.json', 'Cargo.toml', 'go.mod', 'pom.xml'];
const CODE_EXT = /\.(py|ipynb|ts|tsx|js|jsx|go|rs|java|kt|cpp|cc|c|cs|jl|scala|rb|swift)$/i;
const SKIP_DIR = /(^|\/)(node_modules|vendor|dist|build|out|\.venv|venv|env|site-packages|migrations|__pycache__|\.ipynb_checkpoints|\.next|tests?|__tests__|spec|docs?|examples?|scripts?)\//i;
const SKIP_FILE = /(^|\/)(setup\.py|__init__\.py|conftest\.py|manage\.py|[^/]*\.min\.js|[^/]*config[^/]*|[^/]*\.d\.ts)$/i;
const AI_FILE = /(model|agent|train|pipeline|rag|infer|llm|chain|retriev|embed|eval|predict|graph|tool|prompt|dataset)/i;

async function gh(path, { raw = false } = {}) {
  const headers = {
    'User-Agent': 'applicant-evaluator',
    'X-GitHub-Api-Version': '2022-11-28',
    Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
  };
  if (config.github.token) headers.Authorization = `Bearer ${config.github.token}`;

  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(API + path, { headers, signal: AbortSignal.timeout(30_000) });
    } catch (e) {
      if (attempt < 2) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      throw new Error(`GitHub request failed for ${path}: ${e.message}`);
    }

    if (res.ok) return raw ? res.text() : res.json();
    // 404 missing, 409 empty repo, 451 blocked: treat as "nothing there"
    if ([404, 409, 451].includes(res.status)) return null;

    if (res.status === 403 || res.status === 429) {
      const remaining = res.headers.get('x-ratelimit-remaining');
      const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
      const retryAfter = Number(res.headers.get('retry-after')) * 1000;
      const wait = retryAfter || (remaining === '0' && reset ? reset - Date.now() + 1000 : 0);
      if (wait > 0 && wait <= 120_000 && attempt < 3) {
        await sleep(wait);
        continue;
      }
      if (remaining === '0' || res.status === 429) {
        const hint = config.github.token ? '' : ' Set GITHUB_TOKEN to raise the limit from 60 to 5,000 requests/hour.';
        throw new Error(`GitHub rate limit reached (resets ${new Date(reset).toLocaleTimeString()}).${hint}`);
      }
    }
    if (res.status >= 500 && attempt < 2) {
      await sleep(2000);
      continue;
    }
    throw new Error(`GitHub HTTP ${res.status} for ${path}`);
  }
}

const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');

export function parseGithubUsername(input) {
  if (!input) return null;
  const s = String(input).trim();
  const m = s.match(/github\.com\/([A-Za-z0-9-]+)/i);
  const name = (m ? m[1] : s).replace(/^@/, '');
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(name) ? name : null;
}

const isAiRepo = (r) => AI_RE.test([r.name.replace(/[-_]/g, ' '), r.description, (r.topics || []).join(' ')].join(' '));

/** Deterministic pre-ranking so only the most informative repos reach the (paid) reviewers. */
function repoPriority(r, now) {
  const ageMs = now - Date.parse(r.pushed_at);
  let s = Math.log1p(r.stargazers_count) * 2 + Math.log1p(r.forks_count);
  s += isAiRepo(r) ? 3 : 0;
  s += ageMs < YEAR / 2 ? 2 : ageMs < YEAR ? 1 : 0;
  s += Math.log1p(r.size) / 2;
  s += r.description ? 0.5 : 0;
  s -= LOW_SIGNAL_RE.test(r.name) ? 3 : 0;
  s -= r.archived ? 1 : 0;
  return s;
}

export function cleanReadme(md) {
  if (!md) return '';
  const t = md
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, '') // linked badges
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images
    .replace(/<[^>]+>/g, ' ')
    .replace(/\]\((https?:)?[^)]*\)/g, ']') // keep link text, drop URL
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    // drop language-switcher rows ("English |"), table rules and decoration-only lines
    .filter((l) => l.trim() && !/^\s*[^|]{0,25}\|\s*$/.test(l) && !/^[\s|:\-=*_#>]*$/.test(l))
    .join('\n')
    .trim();
  return clip(t, config.budgets.readmeChars);
}

export function condenseManifest(path, text) {
  if (!text) return '';
  const name = path.split('/').pop();
  try {
    if (name === 'package.json') {
      const j = JSON.parse(text);
      return Object.keys({ ...j.dependencies, ...j.devDependencies }).join(', ');
    }
  } catch {
    // fall through to raw text
  }
  if (name === 'pyproject.toml') {
    // Only dependency names: PEP 621 lists and Poetry tables, not tool configuration.
    const names = [];
    for (const m of text.matchAll(/(?:^|\n)\s*dependencies\s*=\s*\[([\s\S]*?)\]/g)) {
      for (const d of m[1].matchAll(/["']([A-Za-z0-9_.-]+)/g)) names.push(d[1]);
    }
    for (const m of text.matchAll(/\[tool\.poetry\.(?:group\.\w+\.)?dependencies\]([\s\S]*?)(?=\n\[|$)/g)) {
      for (const d of m[1].matchAll(/^\s*([A-Za-z0-9_.-]+)\s*=/gm)) if (d[1] !== 'python') names.push(d[1]);
    }
    for (const m of text.matchAll(/\[project\.optional-dependencies\]([\s\S]*?)(?=\n\[|$)/g)) {
      for (const d of m[1].matchAll(/["']([A-Za-z0-9_.-]+)/g)) names.push(d[1]);
    }
    return [...new Set(names)].join(', ') || '(no dependencies listed)';
  }
  if (name === 'requirements.txt') {
    return text
      .split('\n')
      .map((l) => l.replace(/#.*/, '').trim().split(/[=<>~!;[ ]/)[0])
      .filter(Boolean)
      .join(', ');
  }
  return text.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).join('\n');
}

function summarizeTree(tree) {
  const blobs = (tree?.tree || []).filter((t) => t.type === 'blob');
  const ext = {};
  for (const b of blobs) {
    const m = b.path.match(/\.([A-Za-z0-9]+)$/);
    if (m) ext[m[1].toLowerCase()] = (ext[m[1].toLowerCase()] || 0) + 1;
  }
  const top = [...new Set((tree?.tree || []).map((t) => t.path.split('/')[0]))].slice(0, 15);
  const has = (re) => blobs.some((b) => re.test(b.path));
  return {
    blobs,
    line: [
      `${blobs.length} files${tree?.truncated ? '+ (truncated)' : ''}`,
      Object.entries(ext)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([e, n]) => `.${e} ${n}`)
        .join(', '),
      `tests: ${has(/(^|\/)(tests?|__tests__|spec)\/|(_test|\.test|\.spec)\.\w+$|(^|\/)test_[^/]+$/i) ? 'yes' : 'no'}`,
      `CI: ${has(/^\.github\/workflows\/|^\.gitlab-ci|^\.circleci\//) ? 'yes' : 'no'}`,
      `Docker: ${has(/(^|\/)(Dockerfile|docker-compose\.ya?ml)$/i) ? 'yes' : 'no'}`,
      `license: ${has(/^LICEN[CS]E/i) ? 'yes' : 'no'}`,
    ].join(' | '),
    top: top.join(', '),
  };
}

const isNotebook = (path) => /\.ipynb$/i.test(path);

export function pickCodeFile(blobs) {
  let best = null;
  let bestScore = -Infinity;
  for (const b of blobs) {
    if (!CODE_EXT.test(b.path) || SKIP_DIR.test(b.path) || SKIP_FILE.test(b.path)) continue;
    const size = b.size ?? 0;
    // Notebook size is mostly outputs (plots, tables), so allow far bigger files and judge size loosely.
    const nb = isNotebook(b.path);
    if (nb ? size < 1000 || size > 5_000_000 : size < 800 || size > 60_000) continue;
    const depth = b.path.split('/').length - 1;
    const name = b.path.split('/').pop();
    let s = 0;
    s += AI_FILE.test(name) ? 3 : 0;
    s += /^(main|app|server|core|agent)\./i.test(name) ? 1 : 0;
    s -= Math.max(0, depth - 2) * 0.5;
    s -= nb ? Math.abs(Math.log(Math.min(size, 200_000) / 30_000)) / 2 : Math.abs(Math.log(size / 8000)); // prefer mid-sized files
    if (s > bestScore) {
      bestScore = s;
      best = b.path;
    }
  }
  return best;
}

/** Source of a Jupyter notebook's code cells, without outputs (often large base64 images). */
export function notebookToCode(text) {
  let nb;
  try {
    nb = JSON.parse(text);
  } catch {
    return '';
  }
  const cells = nb?.cells ?? nb?.worksheets?.[0]?.cells ?? []; // nbformat 4, then 3
  return cells
    .filter((c) => c?.cell_type === 'code')
    .map((c) => {
      const src = c.source ?? c.input ?? '';
      return (Array.isArray(src) ? src.join('') : String(src)).trim();
    })
    .filter(Boolean)
    .join('\n\n# %%\n');
}

const BOT_RE = /\[bot\]$|^(dependabot|renovate|github-actions)\b/i;
const normId = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/**
 * Who wrote the recent commits. GitHub links a commit to an account only when the commit email is
 * registered on that account, and many students commit with an unregistered email. Unlinked commits
 * are therefore matched to the applicant by git name or email, and otherwise reported separately
 * instead of being counted as someone else's work.
 * @param {object[]} commits GitHub commit list
 * @param {{login: string, name?: string}} user the repo owner
 */
export function summarizeCommits(commits, user) {
  if (!Array.isArray(commits) || !commits.length) return 'no commits visible';
  const login = user.login.toLowerCase();
  const ids = new Set([normId(user.login), normId(user.name)].filter(Boolean));
  const human = commits.filter((c) => !BOT_RE.test(c.author?.login ?? c.commit?.author?.name ?? ''));
  let mine = 0;
  let others = 0;
  let unlinked = 0;
  const unlinkedIds = new Set();
  for (const c of human) {
    const linked = c.author?.login?.toLowerCase();
    if (linked) {
      if (linked === login) mine++;
      else others++;
      continue;
    }
    const a = c.commit?.author ?? {};
    const email = String(a.email ?? '').toLowerCase();
    const emailUser = email.split('@')[0].split('+').pop(); // also handles 123+login@users.noreply.github.com
    if (ids.has(normId(a.name)) || emailUser === login) {
      mine++;
      continue;
    }
    unlinked++;
    unlinkedIds.add(normId(a.name) || email);
  }

  let who = `${mine} of last ${human.length} by applicant`;
  if (unlinked) {
    who +=
      unlinkedIds.size === 1 && !others
        ? `, ${unlinked} by one git identity not linked to any account (the only other author, so likely the applicant)`
        : `, ${unlinked} by git identities not linked to any account`;
  }
  if (others) who += `, ${others} by other accounts`;

  const dates = commits.map((c) => c.commit?.author?.date).filter(Boolean).sort();
  const msgs = [...new Set(human.map((c) => (c.commit?.message || '').split('\n')[0].trim()).filter(Boolean))]
    .slice(0, 6)
    .map((m) => `"${clip(m, 70)}"`);
  return `${who}, ${dates[0]?.slice(0, 7)}..${dates.at(-1)?.slice(0, 7)}; messages: ${msgs.join(', ')}`;
}

async function digestRepo(user, r) {
  const owner = user.login;
  const base = `/repos/${owner}/${encodeURIComponent(r.name)}`;
  const branch = encodeURIComponent(r.default_branch);
  const [readme, tree, commits, languages] = await Promise.all([
    gh(`${base}/readme`, { raw: true }),
    gh(`${base}/git/trees/${branch}?recursive=1`),
    gh(`${base}/commits?per_page=30`),
    gh(`${base}/languages`),
  ]);

  const t = summarizeTree(tree);
  const manifestPath =
    MANIFESTS.find((m) => t.blobs.some((b) => b.path === m)) ??
    t.blobs.find((b) => MANIFESTS.includes(b.path.split('/').pop()) && b.path.split('/').length <= 2)?.path;
  const codePath = pickCodeFile(t.blobs);

  const [manifest, code] = await Promise.all([
    manifestPath ? gh(`${base}/contents/${encPath(manifestPath)}?ref=${branch}`, { raw: true }) : null,
    codePath ? gh(`${base}/contents/${encPath(codePath)}?ref=${branch}`, { raw: true }) : null,
  ]);

  const langTotal = Object.values(languages || {}).reduce((a, b) => a + b, 0) || 1;
  const langs = Object.entries(languages || {})
    .filter(([, n]) => n / langTotal >= 0.01)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([l, n]) => `${l} ${Math.round((n / langTotal) * 100)}%`)
    .join(', ');

  const source = code && isNotebook(codePath) ? notebookToCode(code) : code;
  const codeText = source ? clip(source.split('\n').map((l) => l.trimEnd()).join('\n'), config.budgets.codeChars) : '';

  // Compact plain-text digest: cheaper in tokens than nested JSON.
  const digest = [
    `REPO: ${r.name} | stars ${r.stargazers_count} | forks ${r.forks_count} | created ${r.created_at.slice(0, 7)} | last push ${r.pushed_at.slice(0, 7)}${r.archived ? ' | archived' : ''}`,
    `LANGUAGES: ${langs || r.language || 'unknown'}`,
    r.description && `DESCRIPTION: ${clip(r.description, 200)}`,
    r.topics?.length && `TOPICS: ${r.topics.slice(0, 8).join(', ')}`,
    `FILES: ${t.line}`,
    `TOP-LEVEL: ${t.top}`,
    manifestPath && `DEPENDENCIES (${manifestPath}): ${clip(condenseManifest(manifestPath, manifest), config.budgets.manifestChars)}`,
    `COMMITS: ${summarizeCommits(commits, user)}`,
    `README:\n${cleanReadme(readme) || '(none)'}`,
    codeText && `CODE EXCERPT (${codePath}):\n${codeText}`,
  ]
    .filter(Boolean)
    .join('\n');

  return {
    name: r.name,
    url: r.html_url,
    stars: r.stargazers_count,
    digest,
  };
}

/**
 * Fetch and condense a GitHub profile. Pure data work, no model calls.
 * Cached on disk for GITHUB_CACHE_HOURS to save API quota on re-runs.
 */
export async function collectGithub(username) {
  const cacheFile = join(config.cacheDir, 'github', `${username.toLowerCase()}.json`);
  const cached = readJsonFile(cacheFile);
  if (cached?.v === CACHE_VERSION && Date.now() - cached.fetchedAt < config.github.cacheHours * 3600e3) return cached;

  const now = Date.now();
  const user = await gh(`/users/${encodeURIComponent(username)}`);
  // An organization (e.g. a project the CV links to) is not the applicant's own account.
  if (!user || user.type === 'Organization') {
    const result = { v: CACHE_VERSION, found: false, reason: user ? 'organization' : 'not_found', username: user?.login ?? username, fetchedAt: now };
    writeJsonFile(cacheFile, result);
    return result;
  }

  const repos = (await gh(`/users/${encodeURIComponent(username)}/repos?per_page=100&sort=pushed&type=owner`)) || [];
  const own = repos.filter((r) => !r.fork);
  const langs = {};
  for (const r of own) if (r.language) langs[r.language] = (langs[r.language] || 0) + 1;

  const stats = {
    account_age_years: +((now - Date.parse(user.created_at)) / YEAR).toFixed(1),
    public_repos: user.public_repos,
    own_repos: own.length,
    forked_repos: repos.length - own.length,
    total_stars: own.reduce((s, r) => s + r.stargazers_count, 0),
    repos_pushed_last_12m: own.filter((r) => now - Date.parse(r.pushed_at) < YEAR).length,
    ai_related_repos: own.filter(isAiRepo).length,
    top_languages: Object.entries(langs)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([l, n]) => `${l}(${n})`)
      .join(', '),
  };

  const selected = own
    // The <login>/<login> repo is the profile README, not a project (and its name is the handle).
    .filter((r) => r.size > 0 && r.name.toLowerCase() !== user.login.toLowerCase())
    .map((r) => ({ r, s: repoPriority(r, now) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, config.github.maxRepos)
    .map((x) => x.r);

  const digests = await Promise.all(selected.map((r) => digestRepo(user, r)));

  const result = { v: CACHE_VERSION, found: true, username: user.login, url: user.html_url, stats, repos: digests, fetchedAt: now };
  writeJsonFile(cacheFile, result);
  return result;
}
