import { readFileSync } from 'node:fs';
import { runCritic, runCvAnalyst, runJudge, runRepoReviewer, runSkillsProfiler } from './agents.js';
import { assertLlmConfigured, config, rubric, totalWeight } from './config.js';
import { githubCandidatesFromText, maskIdentity, pdfToText, prepareCv } from './cv.js';
import { collectGithub, parseGithubUsername } from './github.js';
import { Usage } from './llm.js';

export const PIPELINE_VERSION = '2.1';

// Phrases addressed to the evaluator. Ordinary LLM vocabulary ("system prompt", "You are an AI
// assistant") is normal in AI projects and deliberately not matched.
const TARGETED_INJECTION_RE = new RegExp(
  [
    String.raw`\b(give|assign|rate|score|grade|rank)\s+(me|this\s+(candidate|applicant|cv|resume|profile))\s+(as\s+)?(a\s+|an\s+|the\s+)?(10|ten|perfect|maximum|max|top|highest|highly|high|full)\b`,
    String.raw`\b(ai|llms?|models?|gpt|chatgpt|evaluators?|reviewers?|screeners?|recruiters?|graders?|judges?)\s+(must|should|shall|will)\s+(score|rate|rank|recommend|select|shortlist|accept|hire)\s+(me|this\s+(candidate|applicant|cv|resume|profile))\b`,
    String.raw`\b(note|message|instructions?)\s+(to|for)\s+(the\s+|any\s+)?(ai|llm|gpt|chatgpt|automated)\s+(evaluators?|reviewers?|screeners?|recruiters?|graders?|judges?|screening)\b`,
    String.raw`\bnote\s+(to|for)\s+(the\s+|any\s+)?(ai|llms?|gpt|chatgpt)\s*:`,
    String.raw`\byou\s+are\s+now\s+(a|an|the)\s+(\w+\s+){0,2}(evaluator|reviewer|recruiter|screener|grader|judge)\b`,
  ].join('|'),
  'i',
);
// The classic jailbreak phrase. Checked in the CV only, because AI repos legitimately discuss it
// (guardrails, red-teaming); quoted mentions are skipped for the same reason.
const JAILBREAK_RE =
  /(?<!["'“‘])\b(ignore|disregard|forget|override)\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier|your|other)\s+(instructions|prompts?|rules|guidelines|criteria)/i;

// Flags that only route a result to human review. The scoring agents never see them: a regex match
// is not proof of manipulation, and the agents are told to report real attempts themselves.
const ROUTING_ONLY_FLAGS = ['possible_prompt_injection'];

const round1 = (n) => Math.round(n * 10) / 10;

/** Apply maskIdentity to every string in a JSON-like value. */
const redact = (v, identity) =>
  typeof v === 'string'
    ? maskIdentity(v, identity)
    : Array.isArray(v)
      ? v.map((x) => redact(x, identity))
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redact(x, identity)]))
        : v;

/**
 * If the judge omitted a dimension, derive a neutral estimate from the other agents instead of 0.
 * The result is also flagged judge_incomplete, which sends it to human review.
 */
function fallbackScore(key, skills, critic) {
  if (key === 'credibility') return critic?.credibility ?? 5;
  const top = (skills?.skills ?? []).slice(0, 3).map((s) => s.level);
  return top.length ? (top.reduce((a, b) => a + b, 0) / top.length) * 2 : 5; // 0-5 levels -> 0-10
}

/**
 * Evaluate one applicant.
 * @param {{id:string,name?:string,github?:string,cvText?:string,cvPath?:string,cvBuffer?:Buffer}} applicant
 */
export async function evaluateApplicant(applicant, { onProgress = () => {} } = {}) {
  assertLlmConfigured();
  const started = Date.now();
  const usage = new Usage();
  const flags = [];

  // 1. CV: local extraction and cleanup (no tokens)
  onProgress('Reading CV');
  let rawCv = applicant.cvText ?? '';
  if (!rawCv && (applicant.cvBuffer || applicant.cvPath)) {
    try {
      rawCv = await pdfToText(applicant.cvBuffer ?? readFileSync(applicant.cvPath));
    } catch (e) {
      flags.push('cv_unreadable');
      onProgress(`CV could not be read: ${e.message}`);
    }
  }
  // 2. GitHub collection (HTTP only, no tokens). A GitHub username typed in wins. Otherwise try the
  // accounts the CV links, most likely first, skipping organizations (a CV often links projects the
  // applicant only contributed to). This runs before any model call so that the evaluated account's
  // handle is known and can be masked in the CV too, which often links only github.com/<handle>/<repo>.
  const explicitGithub = parseGithubUsername(applicant.github);
  const cvGithubLinks = githubCandidatesFromText(rawCv);
  const ghCandidates = explicitGithub ? [explicitGithub] : cvGithubLinks.slice(0, 3).map((c) => c.login);
  if (!ghCandidates.length) flags.push('no_github');

  let gh = null;
  const misses = new Set();
  for (const login of ghCandidates) {
    onProgress(`Fetching GitHub: ${login}`);
    gh = await collectGithub(login);
    if (gh.found) break;
    misses.add(gh.reason === 'organization' ? 'github_is_organization' : 'github_not_found');
  }
  if (gh && !gh.found) flags.push(...misses);
  if (gh?.found && !gh.repos.length) flags.push('github_no_original_repos');

  // Identity masked from everything the models see: the entered name, a typed-in handle, profile links
  // in the CV and the account actually evaluated.
  const identity = {
    name: applicant.name ?? '',
    handles: [explicitGithub, ...cvGithubLinks.filter((c) => c.profile).map((c) => c.login), gh?.found ? gh.username : null].filter(Boolean),
  };

  const cv = prepareCv(rawCv, identity);
  if (!cv.text && !flags.includes('cv_unreadable')) flags.push('cv_missing');
  if (cv.text && cv.chars < 300) flags.push('cv_very_short'); // likely a scanned image PDF
  if (cv.truncated) flags.push('cv_truncated');

  // 3. CV Analyst and per-repo reviews run in parallel
  const cvTask = cv.text ? (onProgress('CV Analyst running'), runCvAnalyst(cv.text, usage)) : Promise.resolve(null);
  const reviewsTask = gh?.found
    ? (onProgress(`Reviewing ${gh.repos.length} repositories`),
      Promise.all(gh.repos.map((r) => runRepoReviewer({ ...r, digest: maskIdentity(r.digest, identity) }, usage))))
    : Promise.resolve([]);
  const [cvAnalysis, reviews] = await Promise.all([cvTask, reviewsTask]);

  if (TARGETED_INJECTION_RE.test(rawCv) || JAILBREAK_RE.test(rawCv) || (gh?.found && gh.repos.some((r) => TARGETED_INJECTION_RE.test(r.digest)))) {
    flags.push('possible_prompt_injection');
  }

  // 4. Downstream agents only see compact structured findings, never raw CV/code, and no identity:
  // name and handles are masked, and personal profile fields (bio, followers) are never collected.
  const ghNote = !gh ? 'No GitHub provided' : gh.reason === 'organization' ? 'GitHub link points to an organization, not a personal account' : 'GitHub profile not found';
  const panel = redact(
    {
      cv_analysis: cvAnalysis ?? 'No readable CV.',
      github: gh?.found ? gh.stats : `${ghNote} (neutral: evaluate from the other evidence).`,
      repo_reviews: reviews.map(({ url, ...r }) => r),
      automated_flags: flags.filter((f) => !ROUTING_ONLY_FLAGS.includes(f)),
    },
    identity,
  );

  // Skills Profiler and Skeptical Reviewer are independent, so they run in parallel.
  onProgress('Skills Profiler and Skeptical Reviewer running');
  const [skills, critic] = await Promise.all([
    runSkillsProfiler({ cv_analysis: panel.cv_analysis, repo_reviews: panel.repo_reviews }, usage),
    runCritic(panel, usage),
  ]);

  onProgress('Lead Judge running');
  const judge = await runJudge({ ...panel, skills_profile: skills, skeptical_review: critic }, usage);

  // 5. Weighted score computed in code, not by the model.
  const dimensions = {};
  let weighted = 0;
  for (const d of rubric.dimensions) {
    const fromJudge = !judge.missing.includes(d.key);
    const score = fromJudge ? judge.scores[d.key].score : round1(fallbackScore(d.key, skills, critic));
    dimensions[d.key] = {
      label: d.label,
      weight: d.weight,
      score,
      reason: fromJudge ? judge.scores[d.key].reason : 'Judge omitted this; derived from panel findings.',
    };
    weighted += (d.weight * score) / 10;
  }
  if (judge.missing.length) flags.push('judge_incomplete');

  const highConcern = critic.concerns.some((c) => c.severity === 'high');
  const needs_human_review =
    highConcern ||
    judge.confidence === 'low' ||
    flags.some((f) => ['possible_prompt_injection', 'cv_unreadable', 'cv_missing', 'cv_very_short', 'judge_incomplete'].includes(f));

  onProgress('Done');
  return {
    id: applicant.id,
    name: applicant.name ?? '',
    github: gh?.found ? gh.username : (ghCandidates[0] ?? null),
    github_url: gh?.found ? gh.url : null,
    agent_score: round1((weighted * 100) / totalWeight), // 0-100
    dimensions,
    confidence: judge.confidence,
    needs_human_review,
    flags,
    summary: judge.summary,
    strengths: judge.strengths,
    concerns: judge.concerns,
    video_questions: judge.video_questions,
    skills,
    evidence: { cv: cvAnalysis, github_stats: gh?.stats ?? null, repos: reviews, critic },
    usage: usage.toJSON(),
    models: { provider: config.llm.provider, fast: config.llm.fastModel, strong: config.llm.strongModel },
    pipeline_version: PIPELINE_VERSION,
    duration_ms: Date.now() - started,
    evaluated_at: new Date().toISOString(),
  };
}
