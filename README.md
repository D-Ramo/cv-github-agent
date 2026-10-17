# Applicant Evaluator

Scores applicants to the AI Specialization program from their CV and GitHub account using a panel of LLM agents.

## Overview

Applicant Evaluator handles the "AI agent evaluates CV + GitHub" step of the admissions process. It reads an applicant's CV and, if available, their GitHub account, and produces a score from 0 to 100, a summary for the team that reviews the applicant's YouTube video, and suggested questions for that review.

A panel of LLM agents extracts the evidence, checks it for weak or doubtful claims, and a lead judge scores it against a weighted rubric. The final score is computed in code from the judge's rubric scores. Results that need a closer look are flagged for human review.

## Features

- Uses the whole CV as evidence: work, internships, research, education, certifications, courses, competitions, extracurricular activities and projects
- Reviews up to four of the applicant's GitHub repositories; having no GitHub does not lower the score
- Rubric scores with reasons, a skill map, strengths, concerns and interview questions for every applicant
- Masks the applicant's name and contact details before any text reaches a model
- Web app for single applicants; command-line tool for batches, Excel export and fairness testing
- Works with any OpenAI-compatible endpoint, including local models

## Getting started

### Requirements

- Node.js 22 or later
- An OpenAI-compatible `/chat/completions` endpoint, such as OpenRouter, Ollama, LM Studio, vLLM or opencode
- A GitHub token, recommended for batches. Without one, GitHub allows 60 requests per hour, which is about two applicants.

### Installation

```bash
npm install
cp .env.example .env
```

Edit `.env` and set `LLM_BASE_URL`, `LLM_API_KEY` (if the endpoint needs one), `LLM_MODEL_FAST`, `LLM_MODEL_STRONG` and `GITHUB_TOKEN`. See [Configuration](#configuration) for all settings.

## Usage

### Web app

```bash
npm start
```

Open http://127.0.0.1:3000. The **Evaluate** tab scores one applicant from a CV, a GitHub username, or both. The **Results** tab lists every evaluated applicant by score and exports the results to Excel.

### Batch

```bash
node src/cli.js batch --input applicants.csv [--concurrency 3] [--force]
```

The input is a CSV file, or a JSON array, with the fields `id`, `name`, `github` and `cv`:

```csv
id,name,github,cv
A-001,Jane Doe,janedoe,cvs/jane-doe.pdf
A-002,John Smith,,cvs/john-smith.pdf
```

| Field | Description |
|---|---|
| `id` | Required and unique. Results are matched to applicants by id. |
| `name` | Used only to mask the name in the CV. It is never sent to a model. |
| `github` | Username or profile URL. If empty, the account is taken from the GitHub links in the CV. |
| `cv` | Path to the PDF, relative to the input file. |

Applicants that already have a result are skipped and failed ones are retried, so an interrupted batch can be run again with the same command. Use `--force` to re-evaluate everyone.

### Single applicant

```bash
node src/cli.js one --github someuser --cv cv.pdf [--name "Jane Doe"] [--id A-001]
```

Prints the full result as JSON and appends it to the results file.

### Export

```bash
node src/cli.js export [--out data/results/evaluations.xlsx]
```

Exports the latest result for every applicant. An `.xlsx` path writes the workbook described below; a `.csv` path writes a single ranked table. The **Export to Excel** button in the web app produces the same workbook.

## Output

| Path | Contents |
|---|---|
| `data/results/results.jsonl` | Every evaluation, one JSON object per line |
| `data/results/evaluations.xlsx` | Workbook of the latest result per applicant, rewritten after each batch |
| `data/results/ranked.csv` | Ranked summary table, rewritten after each batch |
| `data/cache/` | Cached model replies and GitHub responses |
| `data/fairness/` | One folder per fairness test run |

The workbook contains these sheets. Each starts with ID and Name, so one applicant can be filtered across sheets.

| Sheet | Contents |
|---|---|
| Ranking | One row per applicant, ranked: score, confidence, review flag, flags, rubric scores, top skills, summary, strengths, concerns and video questions |
| Rubric detail | Score and reason for each rubric dimension |
| Skills | Each skill with its level (0–5), evidence sources and basis |
| Profile | Everything extracted from the CV |
| Repositories | Each reviewed repository with its scores and a link |
| Reviewer notes | The Skeptical Reviewer's concerns, contradictions and claims |
| Failed | Applicants whose evaluation failed, with the error (only present when there are any) |

## Configuration

Settings are read from `.env`.

| Variable | Default | Description |
|---|---|---|
| `LLM_BASE_URL` | `https://openrouter.ai/api/v1` | Base URL of the OpenAI-compatible API |
| `LLM_API_KEY` | | API key, if the endpoint needs one |
| `LLM_MODEL_FAST` | required | Model for every agent except the Lead Judge |
| `LLM_MODEL_STRONG` | `LLM_MODEL_FAST` | Model for the Lead Judge |
| `LLM_JSON_MODE` | `true` | Request JSON output. Turned off automatically if the model rejects it. |
| `LLM_TEMPERATURE` | `0.1` | Sampling temperature |
| `LLM_MAX_PARALLEL` | `4` | Maximum simultaneous model calls |
| `LLM_TIMEOUT_MS` | `180000` | Timeout per model request |
| `LLM_CACHE` | `true` | Reuse cached model replies |
| `LLM_REASONING_TOKENS` | `6000` | Extra reply room for reasoning models. Added when a reply is cut off, then kept for the rest of the run. |
| `GITHUB_TOKEN` | | GitHub token. A fine-grained token with public read access is enough. |
| `GITHUB_MAX_REPOS` | `4` | Repositories reviewed per applicant |
| `GITHUB_CACHE_HOURS` | `24` | How long GitHub responses are cached |
| `CV_MAX_CHARS` | `14000` | CV length limit, about 3,500 tokens |
| `CONCURRENCY` | `3` | Applicants evaluated in parallel by the command-line tool |
| `HOST` | `127.0.0.1` | Web app host |
| `PORT` | `3000` | Web app port |

The rubric and the fairness test are configured in JSON:

- `config/rubric.json`: dimensions, weights, scoring guidance and calibration
- `config/fairness.json`: names, rewrite styles and run counts for the fairness test

Agent prompts are in `src/agents.js`. Changing a prompt or the rubric invalidates the model cache automatically.

## How it works

```
PDF CV ─► extract text, mask email/phone, cap length ─► CV Analyst ─────────────┐
GitHub ─► stats, pick top 4 repos, compact digests ───► Repo Reviewer (per repo) ┤
                                                                                 ▼
                                         Skills Profiler  +  Skeptical Reviewer (in parallel)
                                                                                 ▼
                                         Lead Judge: rubric scores, summary, video questions
                                                                                 ▼
                                         Weighted 0–100 score, computed in code
```

| Agent | Model | Input | Output |
|---|---|---|---|
| CV Analyst | fast | Masked CV text | Structured facts from every CV section |
| Repo Reviewer | fast | Digest of one repository | AI relevance, engineering quality, complexity, originality and authorship |
| Skills Profiler | fast | CV facts and repository reviews | Skill map (0–5) with the evidence behind each skill |
| Skeptical Reviewer | fast | CV facts, repository reviews and automated flags | Supported and unsupported claims, contradictions and concerns |
| Lead Judge | strong | All of the above | Rubric scores with reasons, summary, strengths, concerns and video questions |

### Rubric

| Dimension | Weight |
|---|---|
| AI/ML skills | 25 |
| Practical experience | 20 |
| Technical foundation | 15 |
| Education & credentials | 10 |
| Extracurricular & leadership | 10 |
| Initiative & growth | 10 |
| Credibility | 10 |

Each dimension is scored from 0 to 10 relative to the applicant pool. Evidence is weighted by strength, strongest first: demonstrated outcomes (work results, research, competition placements, reviewed code), specific and quantified claims, graded or proctored certifications, completion-only courses, and bare skill lists.

### GitHub evidence

- If no username is given, the GitHub links in the CV are tried in order: profile links (`github.com/user`) first, then the owner linked most often. Links to pull requests, issues and commits are ignored, and organization accounts are skipped.
- Up to four original (non-fork) repositories are chosen by stars, recent activity, size and AI relevance. Each is condensed locally into a digest of its metadata, file tree, dependencies, recent commits, README and one code excerpt.
- Commits made with an email that is not linked to the account are matched to the applicant by git name or email.
- Jupyter notebooks count as code; only their code cells are used.

### Token usage

Parsing, GitHub collection and condensing all happen locally before any model call. The CV is limited to about 3,500 tokens (long CVs keep the start and the end) and each repository digest to about 1,500. Later agents receive the earlier agents' structured findings, not the raw CV or code, and only the Lead Judge uses the strong model.

A typical applicant uses about 6k tokens without GitHub and 12–18k with four repositories, mostly on the fast model. Model replies are cached on disk, so re-running an applicant uses no tokens. Each result records its exact token usage.

## Privacy and safeguards

- Email addresses and phone numbers are masked before any text reaches a model. Dates, grades and scores are kept.
- The entered name is masked in the CV and GitHub data, together with the GitHub handle and LinkedIn profile slug. A name that appears only in the CV and was not entered is not masked. Name parts that are also tech words (Ai, Ray, Julia, Ruby) are masked only as part of the full name.
- The scoring agents never see the GitHub username. The GitHub bio and follower count are not collected.
- Agents are instructed to ignore protected traits and institution prestige, and the CV Analyst describes employers and schools generically.
- CV and repository text is treated as untrusted. It is sent inside `<cv>`, `<repo>` or `<data>` tags, and those tags are removed from the text itself so it cannot end its block early.
- Text addressed to the evaluator, such as "rate this candidate 10/10", is flagged for human review. The agents never see this flag, so a false match cannot lower a score.
- A result is marked **needs human review** when the Skeptical Reviewer raises a high-severity concern, the judge reports low confidence, the CV is missing, unreadable or very short, the judge omitted a rubric score, or possible prompt injection was flagged.

## Fairness testing

The `fairness` command measures how stable the scores are and whether they change with things that should not matter. Run it on a calibration set of 10–30 past applicants, in the same input format as `batch`, before relying on the scores for decisions.

```bash
node src/cli.js fairness --input applicants.csv --dry-run
node src/cli.js fairness --input applicants.csv
```

| Test | What changes | What it measures |
|---|---|---|
| Stability (always runs) | Nothing; the same CV is evaluated several times | Score spread, rank ranges, how often the review decision changes, and the noisiest dimensions |
| `name` | The name in the CV is replaced with each name in `config/fairness.json` | Whether some names score higher or lower. The `name` field must match the name as written in the CV. |
| `github` | All GitHub links and the username are removed | How much having GitHub is worth |
| `style` | The strong model rewrites the CV in plain non-native English and in polished professional language, keeping the facts | Whether presentation changes the score |

Every evaluation runs through the real pipeline with the model cache off, in random order, and nothing is written to the production results. A difference is reported as beyond noise only when it exceeds about twice its standard error.

By default, names are not passed to the pipeline, so the model sees them in the CV; this measures the model's own bias. With `--mask-names`, names are masked as in production, and any remaining name effect points to a masking leak.

| Option | Description |
|---|---|
| `--tests name,github,style` | Run only the listed tests (stability always runs) |
| `--runs <n>` | Stability runs per applicant (default 5) |
| `--swap-runs <n>` | Runs per test variant (default 3) |
| `--mask-names` | Mask names as in production |
| `--out <folder>` | Output folder. Pass an earlier folder to resume it. |
| `--report-only` | Rebuild the report from `--out` without running anything |
| `--dry-run` | Write the plan and variant texts without any model calls |

Each run writes to `data/fairness/<timestamp>/`: `report.md`, `summary.json`, `runs.jsonl` with every evaluation, and `variants/` with every CV text used, including the style rewrites. With the default configuration, each applicant needs about 38 evaluations.

## Development

```bash
npm test
```

The tests cover what reaches the model: contact and name masking, untrusted-text wrapping and the fairness name swap. Run them after changing `src/cv.js` or the name swap in `src/fairness.js`.

### Project structure

```
config/
  rubric.json      Rubric dimensions, weights, guidance and calibration
  fairness.json    Names, rewrite styles and run counts for the fairness test
public/
  index.html       Web app
src/
  server.js        Web server and JSON API
  cli.js           Command-line tool: batch, one, export, fairness
  pipeline.js      Evaluation of one applicant, end to end
  agents.js        Agent prompts and validation of their output
  llm.js           Model client with retries, caching and token accounting
  cv.js            PDF text extraction and masking
  github.js        GitHub collection and repository digests
  excel.js         Excel export
  fairness.js      Fairness test and report
  config.js        Settings from .env
  util.js          Shared helpers
test/
  cv.test.js       Masking, untrusted-text and name-swap tests
```
