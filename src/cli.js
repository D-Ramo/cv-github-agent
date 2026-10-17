#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { config, ROOT, rubric } from './config.js';
import { writeWorkbook } from './excel.js';
import { fairness as fairnessConfig, runFairness, SWAP_TESTS, writeReport } from './fairness.js';
import { Usage } from './llm.js';
import { evaluateApplicant } from './pipeline.js';
import { appendJsonl, latestResults, pLimit, readJsonl } from './util.js';

const HELP = `Usage:
  node src/cli.js batch --input applicants.csv [--concurrency 3] [--force]
      Evaluate every applicant. CSV/JSON columns: id (required, unique), name, github, cv (path to PDF, relative to the input file).
      Results are appended to data/results/results.jsonl; already evaluated ids are skipped unless --force.
  node src/cli.js one --github <user|url> [--cv cv.pdf] [--name "Jane Doe"] [--id A123]
      Evaluate a single applicant and print the result.
  node src/cli.js export [--out data/results/evaluations.xlsx]
      Export all stored results. The format follows the extension: .xlsx (Excel workbook, default) or .csv.
  node src/cli.js fairness --input applicants.csv [--tests name,github,style] [--runs 5] [--swap-runs 3]
                           [--mask-names] [--out data/fairness/<folder>] [--dry-run] [--report-only]
      Re-run applicants with the LLM cache off (stability) and with a swapped name, GitHub removed and
      the CV rewritten in other styles, then write report.md. --dry-run shows the plan without model calls;
      --out with an earlier folder resumes it; --report-only rebuilds the report from that folder.
      Names and styles are in config/fairness.json. Nothing is written to the production results.`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[a.slice(2)] = true;
      else args[a.slice(2)] = argv[++i];
    } else args._.push(a);
  }
  return args;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') row.push(field), (field = '');
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field), (field = '');
      if (row.some((f) => f.trim())) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim())) rows.push(row);
  const header = rows.shift().map((h) => h.trim().toLowerCase().replace(/^﻿/, ''));
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}

function loadApplicants(input) {
  const text = readFileSync(input, 'utf8');
  const rows = extname(input).toLowerCase() === '.json' ? JSON.parse(text) : parseCsv(text);
  const base = dirname(resolve(input));
  const applicants = rows.map((r) => {
    const cv = r.cv || r.cv_path || r.cvpath || '';
    return {
      id: String(r.id || r.applicant_id || '').trim(),
      name: r.name || '',
      github: r.github || r.github_url || '',
      cvPath: cv ? resolve(base, cv) : undefined,
    };
  });
  // Results are matched to applicants by id: a missing or repeated id would skip someone or mix two people up.
  const missing = applicants.flatMap((a, i) => (a.id ? [] : [i + 1]));
  if (missing.length) throw new Error(`No id in applicant row(s) ${missing.join(', ')}. Every applicant needs a unique id.`);
  const seen = new Set();
  const repeated = new Set(applicants.filter((a) => seen.has(a.id) || !seen.add(a.id)).map((a) => a.id));
  if (repeated.size) throw new Error(`Repeated ids: ${[...repeated].join(', ')}. Every applicant needs a unique id.`);
  return applicants;
}

const csvCell = (v) => {
  let s = Array.isArray(v) ? v.join('; ') : String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // stop spreadsheet apps treating applicant text as a formula
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function exportCsv(out) {
  const results = latestResults(config.resultsFile);
  const keys = rubric.dimensions.map((d) => d.key);
  const header = ['rank', 'id', 'name', 'github', 'agent_score', 'confidence', 'needs_human_review', 'flags', ...keys, 'top_skills', 'certifications', 'summary', 'video_questions'];
  const lines = [header.join(',')];
  results.forEach((r, i) => {
    lines.push(
      [i + 1, r.id, r.name, r.github, r.agent_score, r.confidence, r.needs_human_review, r.flags, ...keys.map((k) => r.dimensions[k]?.score), (r.skills?.skills ?? []).slice(0, 5).map((s) => `${s.skill} (${s.level}/5)`), (r.evidence?.cv?.certifications ?? []).map((c) => c.name), r.summary, r.video_questions]
        .map(csvCell)
        .join(','),
    );
  });
  writeFileSync(out, '﻿' + lines.join('\n')); // BOM so Excel opens UTF-8 correctly
  return results.length;
}

const fmtTokens = (u) => `${u.totalTokens.toLocaleString()} tokens (${u.calls} calls, ${u.cacheHits} cached)`;

async function batch(args) {
  if (!args.input) throw new Error('--input is required');
  const applicants = loadApplicants(args.input);
  const done = new Set(args.force ? [] : readJsonl(config.resultsFile).filter((r) => !r.error).map((r) => r.id));
  const todo = applicants.filter((a) => !done.has(a.id));
  console.log(`${applicants.length} applicants, ${applicants.length - todo.length} already evaluated, ${todo.length} to run.`);

  const limit = pLimit(Number(args.concurrency) || config.concurrency);
  const total = new Usage();
  let finished = 0;
  let failed = 0;

  await Promise.all(
    todo.map((a) =>
      limit(async () => {
        try {
          const r = await evaluateApplicant(a);
          appendJsonl(config.resultsFile, r);
          total.merge(r.usage);
          console.log(
            `[${++finished}/${todo.length}] ${a.id} ${r.agent_score.toFixed(1)}${r.needs_human_review ? ' (review)' : ''} | ${fmtTokens(r.usage)} | ${(r.duration_ms / 1000).toFixed(1)}s`,
          );
        } catch (e) {
          failed++;
          appendJsonl(config.resultsFile, { id: a.id, error: e.message, evaluated_at: new Date().toISOString() });
          console.error(`[${++finished}/${todo.length}] ${a.id} FAILED: ${e.message}`);
        }
      }),
    ),
  );

  const out = join(dirname(config.resultsFile), 'ranked.csv');
  const n = exportCsv(out);
  const xlsx = join(dirname(config.resultsFile), 'evaluations.xlsx');
  await writeWorkbook(config.resultsFile, xlsx);
  console.log(`\nDone. ${failed} failed (re-run the same command to retry them). Usage this run: ${fmtTokens(total.toJSON())}`);
  console.log(`Ranked ${n} applicants -> ${xlsx}\n                    -> ${out}`);
}

async function one(args) {
  if (!args.github && !args.cv) throw new Error('--github and/or --cv is required');
  const r = await evaluateApplicant(
    { id: args.id || `cli-${Date.now()}`, name: args.name || '', github: args.github, cvPath: args.cv ? resolve(args.cv) : undefined },
    { onProgress: (s) => console.error(`  … ${s}`) },
  );
  appendJsonl(config.resultsFile, r);
  console.log(JSON.stringify(r, null, 2));
  console.error(`\nAgent score: ${r.agent_score}/100 | ${fmtTokens(r.usage)}`);
}

async function fairness(args) {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
  const outDir = resolve(typeof args.out === 'string' ? args.out : join(ROOT, 'data', 'fairness', stamp));
  if (args['report-only']) {
    if (typeof args.out !== 'string') throw new Error('--report-only needs --out <folder of an earlier fairness run>');
    console.log(`Report -> ${writeReport(outDir).reportFile}`);
    return;
  }
  if (!args.input) throw new Error('--input is required');

  const tests = typeof args.tests === 'string' ? args.tests.split(',').map((t) => t.trim()).filter((t) => t && t !== 'stability') : SWAP_TESTS;
  const unknown = tests.filter((t) => !SWAP_TESTS.includes(t));
  if (unknown.length) throw new Error(`Unknown test: ${unknown.join(', ')}. Choose from: stability, ${SWAP_TESTS.join(', ')}.`);
  const runs = Number(args.runs) || fairnessConfig.runs;
  const swapRuns = Number(args['swap-runs']) || fairnessConfig.swap_runs;
  if (runs < 2) throw new Error('--runs must be at least 2 to measure run-to-run noise');
  if (swapRuns < 2) console.warn('Warning: with --swap-runs 1 the report cannot tell a swap effect from noise.');

  const res = await runFairness({
    applicants: loadApplicants(args.input),
    outDir,
    runs,
    swapRuns,
    tests,
    maskNames: Boolean(args['mask-names']),
    concurrency: Number(args.concurrency) || config.concurrency,
    dryRun: Boolean(args['dry-run']),
  });
  if (res.reportFile) console.log(`\nReport -> ${res.reportFile}\nUsage this run: ${fmtTokens(res.usage)}`);
  else console.log(`\nDry run: no model calls made. The variant CV texts are in ${join(outDir, 'variants')}.`);
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
try {
  if (cmd === 'batch') await batch(args);
  else if (cmd === 'one') await one(args);
  else if (cmd === 'fairness') await fairness(args);
  else if (cmd === 'export') {
    const out = resolve(typeof args.out === 'string' ? args.out : join(dirname(config.resultsFile), 'evaluations.xlsx'));
    if (extname(out).toLowerCase() === '.csv') console.log(`Exported ${exportCsv(out)} applicants -> ${out}`);
    else {
      const { count, failed } = await writeWorkbook(config.resultsFile, out);
      console.log(`Exported ${count} applicants${failed ? ` (+${failed} failed)` : ''} -> ${out}`);
    }
  } else console.log(HELP);
} catch (e) {
  console.error(`Error: ${e.message}`);
  process.exitCode = 1;
}
