import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { Database } from './database.js';
import { env } from './config.js';

export function normalizeVector(value: unknown) {
  const vector = z.array(z.number().finite()).length(768).parse(value); const magnitude = Math.sqrt(vector.reduce((sum, n) => sum + n * n, 0));
  if (!magnitude) throw new Error('Embedding has zero magnitude'); return vector.map(n => n / magnitude);
}
@Injectable()
export class EmbeddingService {
  constructor(@Inject(Database) private readonly db: Database) {}
  configured() { return env.EMBEDDINGS_ENABLED === 'true' && !!env.GEMINI_API_KEY; }
  async vector(text: string) {
    if (!this.configured()) throw new ServiceUnavailableException('Source embeddings are not configured');
    try { const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY, httpOptions: { timeout: 30000 } }); const response = await ai.models.embedContent({ model: env.EMBEDDING_MODEL, contents: text.slice(0, 12000), config: { outputDimensionality: 768 } }); return normalizeVector(response.embeddings?.[0]?.values); }
    catch { throw new ServiceUnavailableException('Embedding provider request failed; check configured model, key and quota'); }
  }
  async indexPending() {
    if (!this.configured()) return;
    const sources = await this.db.source.findMany({ where: { project: { deletedAt: null }, embeddings: { none: { model: env.EMBEDDING_MODEL } } }, orderBy: { retrievedAt: 'desc' }, take: 3 });
    for (const source of sources) {
      const content = source.text.slice(0, 12000); const vector = JSON.stringify(await this.vector(content)); const id = randomUUID();
      await this.db.$executeRaw`INSERT INTO "EmbeddingRecord" (id,"organizationId","projectId","sourceId",model,"contentHash",content,vector,"createdAt") VALUES (${id}::uuid,${source.organizationId}::uuid,${source.projectId}::uuid,${source.id}::uuid,${env.EMBEDDING_MODEL},${source.contentHash},${content},${vector}::vector,NOW()) ON CONFLICT ("organizationId","sourceId",model) DO NOTHING`;
    }
  }
  async retrieve(organizationId: string, projectId: string, question: string) {
    const count = await this.db.embeddingRecord.count({ where: { organizationId, projectId, model: env.EMBEDDING_MODEL } });
    if (!count || !this.configured()) return null;
    const vector = JSON.stringify(await this.vector(question));
    return this.db.tenantRead(organizationId, tx => tx.$queryRaw<{ id: string; url: string; title: string; text: string }[]>`SELECT s.id,s.url,s.title,e.content AS text FROM "EmbeddingRecord" e JOIN "Source" s ON s.id=e."sourceId" AND s."organizationId"=e."organizationId" WHERE e."organizationId"=${organizationId}::uuid AND e."projectId"=${projectId}::uuid AND e.model=${env.EMBEDDING_MODEL} AND e.vector IS NOT NULL ORDER BY e.vector <=> ${vector}::vector LIMIT 6`);
  }
}
