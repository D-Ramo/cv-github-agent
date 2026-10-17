import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

try {
  process.loadEnvFile(join(ROOT, '.env'));
} catch {
  // no .env file: rely on real environment variables
}

const env = process.env;
const num = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

export const config = {
  llm: {
    // Any OpenAI-compatible /chat/completions endpoint: OpenRouter, Ollama, LM Studio, vLLM, opencode, etc.
    provider: 'openai-compatible',
    baseUrl: (env.LLM_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, ''),
    apiKey: env.LLM_API_KEY || '',
    fastModel: env.LLM_MODEL_FAST || '',
    strongModel: env.LLM_MODEL_STRONG || env.LLM_MODEL_FAST || '',
    jsonMode: env.LLM_JSON_MODE !== 'false',
    temperature: num(env.LLM_TEMPERATURE, 0.1),
    timeoutMs: num(env.LLM_TIMEOUT_MS, 180_000),
    maxParallel: num(env.LLM_MAX_PARALLEL, 4),
    // Disk cache of model replies. The fairness harness turns it off so every run is a fresh sample.
    cache: env.LLM_CACHE !== 'false',
    // Extra max_tokens for models whose replies get cut off, e.g. reasoning models that think first.
    reasoningTokens: num(env.LLM_REASONING_TOKENS, 6000),
  },
  github: {
    token: env.GITHUB_TOKEN || '',
    maxRepos: num(env.GITHUB_MAX_REPOS, 4),
    cacheHours: num(env.GITHUB_CACHE_HOURS, 24),
  },
  // Character budgets for everything sent to a model (~4 chars per token).
  budgets: {
    cvChars: num(env.CV_MAX_CHARS, 14000),
    readmeChars: 1800,
    codeChars: 2200,
    manifestChars: 600,
  },
  cacheDir: join(ROOT, 'data', 'cache'),
  resultsFile: join(ROOT, 'data', 'results', 'results.jsonl'),
  host: env.HOST || '127.0.0.1',
  port: num(env.PORT, 3000),
  concurrency: num(env.CONCURRENCY, 3),
};

export const rubric = JSON.parse(readFileSync(join(ROOT, 'config', 'rubric.json'), 'utf8'));
export const totalWeight = rubric.dimensions.reduce((s, d) => s + d.weight, 0);

export function assertLlmConfigured() {
  if (!config.llm.fastModel) {
    throw new Error('LLM_MODEL_FAST is not set. Copy .env.example to .env and fill it in.');
  }
}
