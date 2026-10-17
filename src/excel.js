import ExcelJS from 'exceljs';
import { rubric } from './config.js';
import { latestResults, readJsonl } from './util.js';

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3A6B' } };
const REVIEW_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDE2E1' } };
const join = (v) => (Array.isArray(v) ? v.filter(Boolean).join('\n') : v ?? '');

/** Add a sheet with a styled, frozen, filterable header row. */
function sheet(wb, name, columns, { freezeCols = 2 } = {}) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', xSplit: freezeCols, ySplit: 1 }] });
  ws.columns = columns.map(([header, key, width = 14, wrap = false]) => ({
    header,
    key,
    width,
    style: wrap ? { alignment: { wrapText: true, vertical: 'top' } } : { alignment: { vertical: 'top' } },
  }));
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = HEADER_FILL;
  head.alignment = { vertical: 'middle', wrapText: true };
  head.height = 30;
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  return ws;
}

/** Red-yellow-green colour scale for numeric score columns. */
function colorScale(ws, col, rows, max) {
  if (rows < 1) return;
  const letter = ws.getColumn(col).letter;
  ws.addConditionalFormatting({
    ref: `${letter}2:${letter}${rows + 1}`,
    rules: [
      {
        type: 'colorScale',
        cfvo: [
          { type: 'num', value: 0 },
          { type: 'num', value: max / 2 },
          { type: 'num', value: max },
        ],
        color: [{ argb: 'FFF8696B' }, { argb: 'FFFFEB84' }, { argb: 'FF63BE7B' }],
      },
    ],
  });
}

const link = (text, url) => (url ? { text, hyperlink: url } : text);

/**
 * Build a workbook of every stored evaluation (latest result per applicant):
 * Ranking, Rubric detail, Skills, Profile, Repositories, Reviewer notes, Failed.
 */
export async function buildWorkbook(resultsFile) {
  const results = latestResults(resultsFile);
  const dims = rubric.dimensions;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Applicant Evaluator';
  wb.created = new Date();

  // ---- Ranking: one row per applicant
  const ranking = sheet(
    wb,
    'Ranking',
    [
      ['Rank', 'rank', 7],
      ['ID', 'id', 14],
      ['Name', 'name', 22],
      ['GitHub', 'github', 18],
      ['Agent score (0-100)', 'agent_score', 12],
      ['Confidence', 'confidence', 11],
      ['Needs human review', 'review', 11],
      ['Flags', 'flags', 22, true],
      ...dims.map((d) => [`${d.label} (${d.weight}%)`, d.key, 12]),
      ['Top skills', 'skills', 34, true],
      ['Summary for video reviewers', 'summary', 60, true],
      ['Strengths', 'strengths', 40, true],
      ['Concerns', 'concerns', 40, true],
      ['Video questions', 'questions', 45, true],
      ['Relevant months', 'months', 10],
      ['Evaluated at', 'evaluated_at', 18],
      ['Tokens', 'tokens', 10],
    ],
    { freezeCols: 3 },
  );
  results.forEach((r, i) => {
    const row = ranking.addRow({
      rank: i + 1,
      id: r.id,
      name: r.name,
      github: r.github ? link(r.github, r.github_url) : '',
      agent_score: r.agent_score,
      confidence: r.confidence,
      review: r.needs_human_review ? 'YES' : 'no',
      flags: join(r.flags),
      ...Object.fromEntries(dims.map((d) => [d.key, r.dimensions[d.key]?.score ?? null])),
      skills: join((r.skills?.skills ?? []).slice(0, 5).map((s) => `${s.skill} (${s.level}/5)`)),
      summary: r.summary,
      strengths: join(r.strengths),
      concerns: join(r.concerns),
      questions: join(r.video_questions),
      months: r.evidence?.cv?.relevant_months_total ?? null,
      evaluated_at: r.evaluated_at ? new Date(r.evaluated_at) : null,
      tokens: r.usage?.totalTokens ?? null,
    });
    if (r.needs_human_review) row.getCell('review').fill = REVIEW_FILL;
    if (r.github_url) row.getCell('github').font = { color: { argb: 'FF2F5BD3' }, underline: true };
  });
  ranking.getColumn('evaluated_at').numFmt = 'yyyy-mm-dd hh:mm';
  colorScale(ranking, 'agent_score', results.length, 100);
  for (const d of dims) colorScale(ranking, d.key, results.length, 10);

  // ---- Rubric detail: score and reason per dimension
  const detail = sheet(wb, 'Rubric detail', [
    ['ID', 'id', 14],
    ['Name', 'name', 22],
    ['Dimension', 'dim', 26],
    ['Weight %', 'weight', 9],
    ['Score (0-10)', 'score', 11],
    ['Reason', 'reason', 80, true],
  ]);
  let n = 0;
  for (const r of results)
    for (const d of dims) {
      const x = r.dimensions[d.key];
      if (!x) continue;
      detail.addRow({ id: r.id, name: r.name, dim: d.label, weight: d.weight, score: x.score, reason: x.reason });
      n++;
    }
  colorScale(detail, 'score', n, 10);

  // ---- Skills: one row per skill
  const skills = sheet(wb, 'Skills', [
    ['ID', 'id', 14],
    ['Name', 'name', 22],
    ['Skill', 'skill', 26],
    ['Level (0-5)', 'level', 10],
    ['Evidence sources', 'evidence', 30, true],
    ['Basis', 'basis', 60, true],
  ]);
  n = 0;
  for (const r of results)
    for (const s of r.skills?.skills ?? []) {
      skills.addRow({ id: r.id, name: r.name, skill: s.skill, level: s.level, evidence: s.evidence.join(', '), basis: s.basis });
      n++;
    }
  colorScale(skills, 'level', n, 5);

  // ---- Profile: everything extracted from the CV, one row per item
  const profile = sheet(wb, 'Profile', [
    ['ID', 'id', 14],
    ['Name', 'name', 22],
    ['Category', 'cat', 18],
    ['Item', 'item', 40, true],
    ['Details', 'details', 60, true],
    ['AI / tech related', 'ai', 10],
  ]);
  const yes = (b) => (b ? 'yes' : '');
  for (const r of results) {
    const cv = r.evidence?.cv;
    if (!cv) continue;
    const add = (cat, item, details, ai = '') => profile.addRow({ id: r.id, name: r.name, cat, item, details, ai });
    for (const e of cv.education ?? [])
      add('Education', `${e.level} ${e.field}`.trim(), [e.status, e.grad_year, e.honors, e.relevant_coursework?.join(', ')].filter(Boolean).join(' · '));
    for (const x of cv.experience ?? [])
      add('Experience', x.role, [`${x.type}, ${x.org_type}`, x.months ? `${x.months} months` : '', ...x.highlights].filter(Boolean).join('\n'), yes(x.ai_related));
    for (const c of cv.certifications ?? [])
      add('Certification', c.name, [c.issuer, c.year, `rigor: ${c.rigor}`, c.has_credential_id ? 'credential ID' : ''].filter(Boolean).join(' · '));
    for (const c of cv.courses ?? []) add('Course', c.name, c.provider, yes(c.ai_related));
    for (const p of cv.projects ?? []) add('Project', p.name, `${p.summary} (evidence: ${p.evidence})`, yes(p.ai_related));
    for (const c of cv.competitions_awards ?? []) add('Competition / award', c.name, c.result);
    for (const p of cv.research_publications ?? []) add('Research / publication', p, '');
    for (const x of cv.extracurricular ?? [])
      add('Extracurricular', x.activity, [x.role, x.months ? `${x.months} months` : '', x.summary].filter(Boolean).join(' · '), yes(x.tech_related));
  }

  // ---- Repositories
  const repos = sheet(wb, 'Repositories', [
    ['ID', 'id', 14],
    ['Name', 'name', 22],
    ['Repository', 'repo', 26],
    ['Stars', 'stars', 8],
    ['AI relevance', 'ai', 10],
    ['Engineering', 'eng', 10],
    ['Complexity', 'cx', 10],
    ['Originality', 'orig', 10],
    ['Authorship', 'auth', 10],
    ['What it is', 'what', 50, true],
    ['Red flags', 'flags', 40, true],
  ]);
  n = 0;
  for (const r of results)
    for (const x of r.evidence?.repos ?? []) {
      repos.addRow({
        id: r.id,
        name: r.name,
        repo: link(x.repo, x.url),
        stars: x.stars,
        ai: x.ai_relevance,
        eng: x.engineering_quality,
        cx: x.complexity,
        orig: x.originality,
        auth: x.authorship,
        what: x.what_it_is,
        flags: join(x.red_flags),
      });
      n++;
    }
  for (const k of ['ai', 'eng', 'cx', 'orig']) colorScale(repos, k, n, 10);

  // ---- Reviewer notes from the Skeptical Reviewer
  const notes = sheet(wb, 'Reviewer notes', [
    ['ID', 'id', 14],
    ['Name', 'name', 22],
    ['Type', 'type', 20],
    ['Severity', 'severity', 10],
    ['Note', 'note', 80, true],
  ]);
  for (const r of results) {
    const c = r.evidence?.critic;
    if (!c) continue;
    const add = (type, note, severity = '') => {
      const row = notes.addRow({ id: r.id, name: r.name, type, severity, note });
      if (severity === 'high') row.getCell('severity').fill = REVIEW_FILL;
    };
    for (const x of c.concerns ?? []) add('Concern', x.issue, x.severity);
    for (const x of c.contradictions ?? []) add('Contradiction', x);
    for (const x of c.unsupported_claims ?? []) add('Unsupported claim', x);
    for (const x of c.supported_claims ?? []) add('Supported claim', x);
    for (const x of c.adjustments ?? []) add(`Adjust ${x.dimension} ${x.direction}`, x.reason);
  }

  // ---- Failed: applicants whose latest attempt errored and that have no successful result
  const ok = new Set(results.map((r) => r.id));
  const failedById = new Map();
  for (const r of readJsonl(resultsFile)) if (r?.error && !ok.has(r.id)) failedById.set(r.id, r);
  if (failedById.size) {
    const failed = sheet(wb, 'Failed', [
      ['ID', 'id', 14],
      ['Error', 'error', 90, true],
      ['When', 'when', 20],
    ]);
    for (const r of failedById.values()) failed.addRow({ id: r.id, error: r.error, when: r.evaluated_at });
  }

  return { workbook: wb, count: results.length, failed: failedById.size };
}

export async function writeWorkbook(resultsFile, outPath) {
  const { workbook, count, failed } = await buildWorkbook(resultsFile);
  await workbook.xlsx.writeFile(outPath);
  return { count, failed };
}
