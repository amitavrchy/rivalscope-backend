import { ForbiddenException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { env } from './config.js';
import { Database } from './database.js';
import { RedisStore } from './redis-store.js';
import { createHash } from 'node:crypto';

export const PROMPT_VERSION = 'research-v2';
export class ProviderError extends Error { constructor(public readonly provider: string, public readonly retryable: boolean, public readonly status?: number) { super(`${provider} request failed${status ? ` (HTTP ${status})` : ''}`); } }
export type AiResult<T> = { data: T; tokens: number; inputTokens?: number; outputTokens?: number; provider: string; model: string };
export interface AiProvider { generate<T>(schema: z.ZodType<T>, system: string, input: unknown): Promise<AiResult<T>>; }

export class GeminiProvider implements AiProvider {
  async generate<T>(schema: z.ZodType<T>, system: string, input: unknown): Promise<AiResult<T>> {
    if (!env.GEMINI_API_KEY) throw new ServiceUnavailableException('Gemini is not configured. Set GEMINI_API_KEY.');
    try {
      const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY, httpOptions: { timeout: 60_000 } });
      const response = await ai.models.generateContent({ model: env.GEMINI_MODEL, contents: JSON.stringify(input), config: { systemInstruction: system, responseMimeType: 'application/json', responseJsonSchema: z.toJSONSchema(schema), maxOutputTokens: 6000, temperature: 0.1 } });
      if (!response.text || response.text.length > 100_000) throw new ProviderError('gemini', false);
      return { data: schema.parse(JSON.parse(response.text)), tokens: response.usageMetadata?.totalTokenCount ?? 0, inputTokens: response.usageMetadata?.promptTokenCount ?? 0, outputTokens: (response.usageMetadata?.candidatesTokenCount ?? 0) + (response.usageMetadata?.thoughtsTokenCount ?? 0), provider: 'gemini', model: env.GEMINI_MODEL };
    } catch (error) {
      if (error instanceof ProviderError || error instanceof z.ZodError || error instanceof SyntaxError) throw error;
      const status = Number((error as { status?: number }).status || 0);
      throw new ProviderError('gemini', !status || status === 429 || status >= 500, status || undefined);
    }
  }
}
export class OpenAiProvider implements AiProvider {
  async generate<T>(schema: z.ZodType<T>, system: string, input: unknown): Promise<AiResult<T>> {
    if (!env.OPENAI_API_KEY || !env.OPENAI_MODEL) throw new ServiceUnavailableException('OpenAI is not configured. Set OPENAI_API_KEY and OPENAI_MODEL.');
    const response = await fetch('https://api.openai.com/v1/responses', { method: 'POST', signal: AbortSignal.timeout(60_000), headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: env.OPENAI_MODEL, instructions: system, input: JSON.stringify(input), max_output_tokens: 6000, text: { format: { type: 'json_schema', name: 'research', strict: true, schema: z.toJSONSchema(schema) } } }) });
    if (!response.ok) throw new ProviderError('openai', response.status === 429 || response.status >= 500, response.status);
    const raw = z.object({ output: z.array(z.object({ type: z.string(), content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional() })), usage: z.object({ total_tokens: z.number(), input_tokens: z.number().optional(), output_tokens: z.number().optional() }).optional() }).parse(await response.json());
    const text = raw.output.flatMap(o => o.content ?? []).filter(c => c.type === 'output_text').map(c => c.text).join('');
    return { data: schema.parse(JSON.parse(text)), tokens: raw.usage?.total_tokens ?? 0, inputTokens: raw.usage?.input_tokens ?? 0, outputTokens: raw.usage?.output_tokens ?? 0, provider: 'openai', model: env.OPENAI_MODEL };
  }
}

@Injectable()
export class AiService implements AiProvider {
  constructor(@Inject(Database) private readonly db: Database, @Inject(RedisStore) private readonly redis: RedisStore) {}
  assertConfigured() {
    if (env.AI_PROVIDER === 'gemini' && !env.GEMINI_API_KEY) throw new ServiceUnavailableException('Gemini API key is missing');
    if (env.AI_PROVIDER === 'openai' && (!env.OPENAI_API_KEY || !env.OPENAI_MODEL)) throw new ServiceUnavailableException('OpenAI API key or model is missing');
  }
  async generate<T>(schema: z.ZodType<T>, system: string, input: unknown, context?: { organizationId: string; runId?: string }): Promise<AiResult<T>> {
    this.assertConfigured();
    const serialized = JSON.stringify(input);
    if (serialized.length + system.length > env.AI_MAX_INPUT_CHARS) throw new ForbiddenException('Research input exceeds the configured model budget');
    const model = env.AI_PROVIDER === 'gemini' ? env.GEMINI_MODEL : env.OPENAI_MODEL!;
    const cacheKey = context ? `rs:ai:${context.organizationId}:${env.AI_PROVIDER}:${model}:${createHash('sha256').update(system + serialized).digest('hex')}` : null;
    if (cacheKey) { const cached = await this.redis.client.get(cacheKey).catch(() => null); if (cached) { try { const parsed = JSON.parse(cached) as AiResult<unknown>; return { ...parsed, data: schema.parse(parsed.data), tokens: 0, inputTokens: 0, outputTokens: 0 }; } catch { /* Ignore corrupt/old cache and validate a fresh provider response. */ } } }
    const providers = { gemini: new GeminiProvider(), openai: new OpenAiProvider() };
    const call = async (provider: 'gemini' | 'openai') => {
      const started = Date.now(); const reserved = Buffer.byteLength(serialized + system) + 6000;
      const budgetKey = `rs:ai-budget:${context?.organizationId || 'platform'}:${new Date().toISOString().slice(0, 10)}`;
      const limitSetting = await this.db.systemSetting.findUnique({ where: { id: 'research_daily_token_limit' } });
      const limit = typeof limitSetting?.value === 'number' ? limitSetting.value : env.AI_DAILY_TOKEN_LIMIT;
      const accepted = await this.redis.client.eval("local n=tonumber(redis.call('GET',KEYS[1]) or '0');if n+tonumber(ARGV[1])>tonumber(ARGV[2]) then return 0 end;redis.call('INCRBY',KEYS[1],ARGV[1]);redis.call('EXPIRE',KEYS[1],172800);return 1", 1, budgetKey, reserved, limit);
      if (!accepted) throw new ForbiddenException('Daily AI token budget reached. Wait for the next UTC day or ask the administrator.');
      try {
        const result = await providers[provider].generate(schema, system, input);
        await this.redis.client.incrby(budgetKey, result.tokens - reserved);
        const cost = provider === env.AI_PROVIDER && env.AI_INPUT_USD_PER_MILLION !== undefined && env.AI_OUTPUT_USD_PER_MILLION !== undefined ? BigInt(Math.ceil((result.inputTokens ?? 0) * env.AI_INPUT_USD_PER_MILLION + (result.outputTokens ?? 0) * env.AI_OUTPUT_USD_PER_MILLION)) : null;
        await this.db.providerUsage.create({ data: { organizationId: context?.organizationId, runId: context?.runId, provider, model: result.model, promptVersion: PROMPT_VERSION, inputTokens: result.inputTokens ?? 0, outputTokens: result.outputTokens ?? 0, totalTokens: result.tokens, estimatedCostMicros: cost, durationMs: Date.now() - started, status: 'completed' } });
        if (cacheKey) await this.redis.client.set(cacheKey, JSON.stringify(result), 'EX', 3600).catch(() => undefined);
        return result;
      } catch (error) {
        // Keep the conservative token hold on failed calls because the provider may have consumed tokens.
        await this.db.providerUsage.create({ data: { organizationId: context?.organizationId, runId: context?.runId, provider, model: provider === 'gemini' ? env.GEMINI_MODEL : env.OPENAI_MODEL!, promptVersion: PROMPT_VERSION, durationMs: Date.now() - started, status: 'failed_usage_unknown' } }); throw error;
      }
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      try { return await call(env.AI_PROVIDER); }
      catch (error) {
        if (!(error instanceof ProviderError) || !error.retryable) throw error;
        if (attempt === 1) {
          if (env.AI_FALLBACK_PROVIDER && env.AI_FALLBACK_PROVIDER !== env.AI_PROVIDER) return call(env.AI_FALLBACK_PROVIDER);
          throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 1000));
      }
    }
    throw new Error('Provider attempts exhausted');
  }
}

export type SearchResult = { url: string; title: string };
export interface SearchAdapter { readonly name: string; assertConfigured(): void; search(query: string, maxResults: number): Promise<SearchResult[]>; }
const searchSchema = z.object({ results: z.array(z.object({ url: z.url(), title: z.string(), content: z.string().optional() })).max(20) });
export class TavilySearchAdapter implements SearchAdapter {
  readonly name = 'tavily';
  assertConfigured() { if (!env.TAVILY_API_KEY) throw new ServiceUnavailableException('Web discovery requires TAVILY_API_KEY. Add known public source URLs to run research without discovery.'); }
  async search(query: string, maxResults: number): Promise<SearchResult[]> {
    this.assertConfigured();
    const response = await fetch('https://api.tavily.com/search', { method: 'POST', signal: AbortSignal.timeout(20_000), headers: { authorization: `Bearer ${env.TAVILY_API_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ query, max_results: maxResults, search_depth: 'basic', include_raw_content: false }) });
    if (!response.ok) throw new ProviderError(this.name, response.status === 429 || response.status >= 500, response.status);
    return searchSchema.parse(await response.json()).results.map(r => ({ url: r.url, title: r.title }));
  }
}
@Injectable()
export class SearchService {
  private readonly adapter: SearchAdapter = new TavilySearchAdapter();
  constructor(@Inject(RedisStore) private readonly redis: RedisStore) {}
  assertConfigured() { this.adapter.assertConfigured(); }
  async search(query: string, maxResults = 5) {
    this.assertConfigured(); const normalized = query.trim().replace(/\s+/g, ' ').slice(0, 400); const limit = Math.max(1, Math.min(10, maxResults));
    const cacheKey = `rs:search:${this.adapter.name}:${createHash('sha256').update(normalized + limit).digest('hex')}`;
    const cached = await this.redis.client.get(cacheKey).catch(() => null);
    if (cached) { try { return searchSchema.parse({ results: JSON.parse(cached) }).results.map(r => ({ url: r.url, title: r.title })); } catch { /* Validate fresh results instead. */ } }
    const result = await this.adapter.search(normalized, limit);
    const results = [...new Map(result.map(r => { const u = new URL(r.url); u.hash = ''; return [u.href, { url: u.href, title: r.title }]; })).values()];
    await this.redis.client.set(cacheKey, JSON.stringify(results), 'EX', 3600).catch(() => undefined); return results;
  }
}
