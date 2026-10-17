# Applicant Evaluator: AI agent for CV + GitHub

This tool handles the **"AI agent evaluates CV + GitHub"** step of the admissions flow. It gives each applicant an agent score from 0 to 100, a summary for the team that reviews the YouTube video, and suggested questions for that review.

## How it works

GitHub is **optional**. The whole CV counts as evidence: jobs, internships, research, education and coursework, certifications, online courses, competitions, extracurricular activities and projects. GitHub, when present, adds evidence and can confirm claims. Having no GitHub is neutral and lowers no score.

```
PDF CV ─► extract text, mask email/phone, cap length ─► CV Analyst (fast): facts from EVERY section ─┐
GitHub ─► stats, pick top 4 repos, compact digest ────► Repo Reviewer ×4 (fast), skipped if none ────┤
                                                                                                     ▼
                     Skills Profiler (fast): skill map 0-5, with the evidence source of each ┐ in parallel
                     Skeptical Reviewer (fast): plausibility, specificity, credential rigor  ┘
                                                                                                     ▼
                     Lead Judge (strong model): rubric scores + summary + video questions
                                                                                                     ▼
                     Weighted 0-100 score computed in code (config/rubric.json)
```

Rubric (weights in config/rubric.json): AI/ML skills 25, practical experience 20, technical foundation 15, education & credentials 10, extracurricular & leadership 10, initiative & growth 10, credibility 10.

Evidence is weighted by strength, strongest first:
1. Demonstrated outcomes: work results, research, competition placements, reviewed code.
2. Specific, quantified claims.
3. Graded or proctored certifications.
4. Completion-only courses.
5. Bare skill lists.

How it keeps token use low:
- **No tokens before the agents run.** The PDF is parsed, GitHub data is fetched, repos are pre-ranked, and READMEs, dependencies and the file tree are condensed locally.
- **Hard size limits on every input.** The CV is capped at about 3.5k tokens; longer CVs keep the start and the end, so sections near the end like certifications and activities are not lost. Each repo digest is capped at about 1.5k. Only the 4 most informative repos are reviewed.
- **The cheap model does most of the work.** Only the Lead Judge uses the strong model, once per applicant.
- **Later agents never see raw text.** The Critic and the Judge get the earlier agents' compact JSON (about 1–2k tokens), not the CV or the code.
- **Results are cached on disk.** Re-running an applicant costs 0 tokens. GitHub responses are cached for 24h.
- **System prompts never change between applicants**, so providers that support prefix caching can reuse them.

A typical applicant costs about 6k tokens without GitHub and about 12–18k with 4 repos, mostly on the fast model. Each result includes its exact token usage.

Safeguards:
- Contact details are masked before anything reaches the model. Dates, GPAs and scores are left intact.
- The name you enter is never sent to the model, and it is masked wherever it appears in the CV and the GitHub data. So are the applicant's GitHub handle and LinkedIn profile slug. A name that is only in the CV, and not entered, is not masked. Name parts that are also tech words (Ai, Ray, Julia, Ruby) are masked only as part of the full name, so "AI" and "Ray Tune" stay readable.
- The scoring agents never see the GitHub username. The GitHub bio and follower count are not collected.
- Agents are told to ignore protected traits and institution prestige, and the CV Analyst describes employers and schools generically.
- CV and README text is treated as untrusted. It is sent inside `<cv>`, `<repo>` or `<data>` tags, and those tags are removed from the text itself so it cannot close its block early. A regex flags text addressed to the evaluator (e.g. "rate this candidate 10/10") for human review. The flag is not shown to the scoring agents, so a false match never lowers a score. Ordinary LLM vocabulary such as "system prompt" is not flagged.
- Results with a high-severity concern, low confidence, or an unreadable CV are marked **needs human review**.

GitHub evidence:
- If no username is entered, the CV's GitHub links are tried in order: profile links (`github.com/user`) first, then the owner linked most often. Links to pull requests, issues and commits are ignored, and organization accounts are skipped, so a CV that mentions `github.com/huggingface/transformers` is not evaluated as Hugging Face.
- Commits made with an email that is not linked to the GitHub account are matched to the applicant by git name or email, so they do not look like someone else's work.
- Jupyter notebooks count as code: their code cells (without outputs) can be the code excerpt.

## Setup

```bash
npm install
cp .env.example .env   # then set LLM_BASE_URL, LLM_MODEL_FAST, LLM_MODEL_STRONG, GITHUB_TOKEN
```

Any OpenAI-compatible endpoint works: OpenRouter, Ollama (`http://localhost:11434/v1`), LM Studio, vLLM, or opencode. For a batch, set `GITHUB_TOKEN`: without it GitHub allows only 60 requests/hour, which is about 2 applicants.

## Use

**Web app** (single applicant, plus a ranked results table): open http://127.0.0.1:3000 after running:

```bash
npm start
```

**Batch:**

```bash
node src/cli.js batch --input applicants.csv --concurrency 3
```

The CSV columns are `id,name,github,cv`. Every row needs its own `id`: the batch stops with an error on a missing or repeated id, because results are matched to applicants by id. `cv` is a PDF path relative to the CSV file. If `github` is empty, the GitHub account is taken from the CV's links (see "GitHub evidence" above). Fill in `name` so it can be masked in the CV. For example:

```csv
id,name,github,cv
A-001,Jane Doe,janedoe,cvs/jane-doe.pdf
A-002,John Smith,,cvs/john-smith.pdf
```

- Results are appended to `data/results/results.jsonl`. After each batch run, `data/results/evaluations.xlsx` and `data/results/ranked.csv` are rewritten.
- Re-running skips applicants that are already done and retries failed ones. Use `--force` to re-evaluate everyone.

**One applicant:**

```bash
node src/cli.js one --github someuser --cv cv.pdf
```

**Export to Excel.** Use the **Export to Excel** button on the web app's Results tab, or the command below. It writes `data/results/evaluations.xlsx`; use `--out file.xlsx` to choose another path, or `--out file.csv` for CSV.

```bash
node src/cli.js export
```

The workbook includes the latest result for every applicant:

| Sheet | Contents |
|---|---|
| Ranking | One row per applicant, ranked: score, confidence, needs-review, flags, every rubric score, top skills, summary, strengths, concerns, video questions. Colour-scaled, filterable, header frozen. |
| Rubric detail | Score and reason for each dimension |
| Skills | Each skill with level 0-5, evidence sources and basis |
| Profile | Everything extracted from the CV: experience, education, certifications, courses, projects, competitions, research, extracurriculars |
| Repositories | Each reviewed repo with its scores and a link |
| Reviewer notes | The Skeptical Reviewer's concerns, contradictions, and supported and unsupported claims |
| Failed | Applicants whose evaluation errored, with the error (only if there are any) |

Every sheet starts with ID and Name, so you can filter one applicant across sheets.

## Fairness testing

Use this command to check how stable and fair the scores are before trusting them for real decisions. Run it on a small calibration set, e.g. 10–30 past applicants, in the same CSV format as `batch`:

```bash
node src/cli.js fairness --input applicants.csv --dry-run
node src/cli.js fairness --input applicants.csv
```

The LLM cache is turned off, so every run is a fresh sample. All runs go through the real pipeline, in random order. Nothing is written to the production results.

| Test | What changes | What it tells you |
|---|---|---|
| Stability (always) | Nothing: the same CV runs `--runs` times (default 5) | Score SD, rank ranges, how often the human-review decision flips, noisiest dimensions |
| `name` | The applicant's name in the CV is replaced by each name in `config/fairness.json` | Whether some names score higher or lower. The `name` column must hold the name exactly as it appears in the CV |
| `github` | Every GitHub link and the username are removed | How much having GitHub is worth. The rubric says no GitHub must be neutral |
| `style` | The strong model rewrites the CV in plain non-native English and in polished coach language, keeping the facts. Contact details are masked before the rewrite | Whether presentation changes the score. Rewrites are saved in `variants/` for you to read |

Each swap variant runs `--swap-runs` times (default 3). A difference is reported as beyond noise only when it is bigger than about twice its standard error. Use `--tests name,github` to run some of the tests, and `--dry-run` to see the plan and the variant texts without any model calls.

By default names are **not** passed to the pipeline, so the model sees them in the CV. This measures the model's own bias. Add `--mask-names` to test the production setup instead, where the entered name is masked; any name effect left is then a masking leak.

Results go to `data/fairness/<date>/`:
- `report.md`: the readable report
- `summary.json`: the same numbers, machine-readable
- `runs.jsonl`: every evaluation
- `variants/`: every CV text used

A run is long: about applicants × (5 + 3 × (8 names + 1 + 2 styles)) ≈ 38 evaluations each with the default config. Re-run with `--out <that folder>` to resume after an interruption. Add `--report-only` to rebuild the report from that folder.

## Tuning

- `config/rubric.json` holds the dimensions, weights, guidance and calibration. Edit it without touching any code.
- `config/fairness.json` holds the fairness test's names, rewrite styles and run counts.
- Prompts are in `src/agents.js`. Changing a prompt or the rubric automatically invalidates the LLM cache.
- `npm test` checks what reaches the model: contact and name masking, the untrusted-text tags and the fairness name swap. Run it after changing `src/cv.js` or `swapName`.
- Size limits and parallelism are set in `.env` (see `.env.example`).
- Reasoning models (e.g. DeepSeek V4 Pro) think before answering, and that thinking counts toward the reply limit. When a reply is cut off, the model is retried once with `LLM_REASONING_TOKENS` (default 6000) of extra room, and it keeps that room for the rest of the run.
