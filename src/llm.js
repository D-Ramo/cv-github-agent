import { join } from 'node:path';
import { config } from './config.js';
import { pLimit, readJsonFile, sha256, sleep, writeJsonFile } from './util.js';

/** Token accounting for one applicant (or a whole batch via merge). */
export class Usage {
  constructor() {
    this.calls = 0;
    this.cacheHits = 0;
    this.promptTokens = 0;
    this.completionTokens = 0;
    this.byAgent = {};
  }

  record(agent, usage, { cached = false } = {}) {
    const a = (this.byAgent[agent] ??= { calls: 0, cacheHits: 0, promptTokens: 0, completionTokens: 0 });
    if (cached) {
      this.cacheHits++;
      a.cacheHits++;
      return;
    }
    const p = usage?.prompt_tokens ?? 0;
    const c = usage?.completion_tokens ?? 0;
    this.calls++;
    this.promptTokens += p;
    this.completionTokens += c;
    a.calls++;
    a.promptTokens += p;
    a.completionTokens += c;
  }

  merge(u) {
    if (!u) return this;
    this.calls += u.calls;
    this.cacheHits += u.cacheHits;
    this.promptTokens += u.promptTokens;
    this.completionTokens += u.completionTokens;
    for (const [k, v] of Object.entries(u.byAgent ?? {})) {
      const a = (this.byAgent[k] ??= { calls: 0, cacheHits: 0, promptTokens: 0, completionTokens: 0 });
      for (const f of Object.keys(a)) a[f] += v[f] ?? 0;
    }
    return this;
  }

  toJSON() {
    const { calls, cacheHits, promptTokens, completionTokens, byAgent } = this;
    return { calls, cacheHits, promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, byAgent };
  }
}

const limit = pLimit(config.llm.maxParallel);
let jsonModeSupported = config.llm.jsonMode;
// Reasoning models spend part of max_tokens thinking before they answer. Once a model's reply is cut
// off, it gets config.llm.reasoningTokens of extra room on every call.
const needsReasoningRoom = new Set();

async function chat(model, messages, maxTokens) {
  const headers = { 'Content-Type': 'application/json' };
  if (config.llm.apiKey) headers.Authorization = `Bearer ${config.llm.apiKey}`;
  if (config.llm.baseUrl.includes('openrouter.ai')) headers['X-Title'] = 'Applicant Evaluator';

  const body = { model, messages, temperature: config.llm.temperature, max_tokens: maxTokens };

  for (let attempt = 0; ; attempt++) {
    if (jsonModeSupported) body.response_format = { type: 'json_object' };
    else delete body.response_format;

    let res;
    let data;
    try {
      res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.llm.timeoutMs),
      });
      // The connection can also drop while the reply is being read (ECONNRESET): retried the same way.
      if (res.ok) data = await res.json();
    } catch (e) {
      if (attempt < 3) {
        await sleep(2000 * 2 ** attempt);
        continue;
      }
      throw new Error(`LLM request failed (${config.llm.baseUrl}): ${e.cause?.code ?? e.message}`);
    }

    if (res.ok) {
      // OpenRouter reports upstream provider failures as HTTP 200 with an error body; they are usually transient.
      if (data.error && attempt < 3) {
        await sleep(2000 * 2 ** attempt);
        continue;
      }
      if (data.error) throw new Error(`LLM error: ${JSON.stringify(data.error).slice(0, 300)}`);
      const msg = data.choices?.[0]?.message ?? {};
      return { content: msg.content ?? '', usage: data.usage, finishReason: data.choices?.[0]?.finish_reason };
    }

    const text = await res.text();
    // Some models/providers reject JSON mode: fall back to prompt-only JSON once and remember.
    if (res.status === 400 && jsonModeSupported && /response_format|json/i.test(text)) {
      jsonModeSupported = false;
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      const retryAfter = Number(res.headers.get('retry-after')) * 1000;
      await sleep(retryAfter || 2000 * 2 ** attempt);
      continue;
    }
    throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
}

export function extractJson(text) {
  let t = String(text ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1];
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('model output contained no JSON object');
  return JSON.parse(t.slice(start, end + 1));
}

/**
 * Call one agent and return its parsed JSON.
 * Responses are cached on disk by (model, prompt), so re-running an applicant costs no tokens
 * (unless config.llm.cache is off).
 */
export async function callJSON({ agent, tier = 'fast', system, user, maxTokens = 700, usage }) {
  const model = tier === 'strong' ? config.llm.strongModel : config.llm.fastModel;
  const key = sha256([config.llm.baseUrl, model, system, user].join('\u0000'));
  const cacheFile = join(config.cacheDir, 'llm', key.slice(0, 2), `${key}.json`);
  const hit = config.llm.cache ? readJsonFile(cacheFile) : null;
  if (hit) {
    usage?.record(agent, null, { cached: true });
    return hit;
  }

  const out = await limit(async () => {
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
    const budget = () => maxTokens + (needsReasoningRoom.has(model) ? config.llm.reasoningTokens : 0);
    let first = await chat(model, messages, budget());
    usage?.record(agent, first.usage);
    if (first.finishReason === 'length' && !needsReasoningRoom.has(model)) {
      // Cut off (usually a reasoning model that used the whole budget to think): retry once with room.
      needsReasoningRoom.add(model);
      first = await chat(model, messages, budget());
      usage?.record(agent, first.usage);
    }
    try {
      return extractJson(first.content);
    } catch {
      // One cheap repair attempt instead of re-running the whole prompt from scratch.
      const repair = await chat(
        model,
        [
          ...messages,
          { role: 'assistant', content: String(first.content).slice(0, 1500) },
          { role: 'user', content: 'That was not valid JSON. Reply with ONLY the JSON object in the required schema.' },
        ],
        budget(),
      );
      usage?.record(agent, repair.usage);
      return extractJson(repair.content);
    }
  });

  if (config.llm.cache) writeJsonFile(cacheFile, out);
  return out;
}
