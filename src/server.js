import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import express from 'express';
import multer from 'multer';
import { config, ROOT } from './config.js';
import { buildWorkbook } from './excel.js';
import { evaluateApplicant } from './pipeline.js';
import { appendJsonl, latestResults } from './util.js';

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const jobs = new Map();

app.use(express.static(join(ROOT, 'public')));

app.get('/api/config', (_req, res) => {
  res.json({
    endpoint: new URL(config.llm.baseUrl).host,
    fastModel: config.llm.fastModel,
    strongModel: config.llm.strongModel,
    githubToken: Boolean(config.github.token),
  });
});

app.post('/api/evaluate', upload.single('cv'), (req, res) => {
  const { name = '', github = '', id = '' } = req.body ?? {};
  if (!req.file && !github.trim()) return res.status(400).json({ error: 'Provide a CV PDF and/or a GitHub username.' });
  if (req.file && !req.file.buffer.subarray(0, 5).toString().startsWith('%PDF')) {
    return res.status(400).json({ error: 'The CV must be a PDF file.' });
  }

  const job = { id: randomUUID(), status: 'running', steps: [], result: null, error: null, created: Date.now() };
  jobs.set(job.id, job);

  evaluateApplicant(
    { id: id.trim() || `web-${Date.now()}`, name: name.trim(), github: github.trim(), cvBuffer: req.file?.buffer },
    { onProgress: (s) => job.steps.push(s) },
  )
    .then((r) => {
      appendJsonl(config.resultsFile, r);
      job.result = r;
      job.status = 'done';
    })
    .catch((e) => {
      job.error = e.message;
      job.status = 'error';
    });

  res.status(202).json({ jobId: job.id });
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Unknown job' });
  res.json(job);
});

app.get('/api/results', (_req, res) => {
  res.json(
    latestResults(config.resultsFile).map((r) => ({
      id: r.id,
      name: r.name,
      github: r.github,
      agent_score: r.agent_score,
      confidence: r.confidence,
      needs_human_review: r.needs_human_review,
      flags: r.flags,
      evaluated_at: r.evaluated_at,
    })),
  );
});

app.get('/api/export.xlsx', async (_req, res, next) => {
  try {
    const { workbook } = await buildWorkbook(config.resultsFile);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="evaluations-${stamp}.xlsx"`);
    res.send(Buffer.from(await workbook.xlsx.writeBuffer()));
  } catch (e) {
    next(e);
  }
});

app.get('/api/results/:id', (req, res) => {
  const r = latestResults(config.resultsFile).find((x) => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  res.json(r);
});

// Forget finished jobs after an hour.
setInterval(() => {
  for (const [id, j] of jobs) if (j.status !== 'running' && Date.now() - j.created > 3600e3) jobs.delete(id);
}, 600e3).unref();

app.listen(config.port, config.host, () => {
  console.log(`Applicant evaluator on http://${config.host}:${config.port}  (provider: ${config.llm.provider}, fast: ${config.llm.fastModel || '-'}, strong: ${config.llm.strongModel || '-'})`);
});
