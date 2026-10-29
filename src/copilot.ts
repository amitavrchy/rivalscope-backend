import { hasActiveEntitlement } from './entitlements.js';
import { Body, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { Database } from './database.js';
import { SessionGuard, TenantPolicy } from './security.js';
import type { ActorRequest } from './security.js';
import { uuid } from './organizations.js';
import { AiService } from './providers.js';
import { isolationPrompt } from './research-schemas.js';
import { json } from './research.js';
import { lockOrganization } from './credits.js';
import { EmbeddingService } from './embeddings.js';
import { OperationPolicy } from './operations.js';

export const copilotSchema = z.object({ answer: z.string().min(1).max(6000), citations: z.array(z.object({ sourceId: z.uuid(), quotation: z.string().min(20).max(600) })).max(10), limitations: z.array(z.string().max(500)).max(8) });

@Controller('organizations/:orgId/projects/:projectId/copilot')
@UseGuards(SessionGuard)
export class CopilotController {
  constructor(@Inject(Database) private readonly db: Database, @Inject(TenantPolicy) private readonly policy: TenantPolicy, @Inject(AiService) private readonly ai: AiService, @Inject(EmbeddingService) private readonly embeddings: EmbeddingService, @Inject(OperationPolicy) private readonly operations: OperationPolicy) {}
  @Get('threads') async threads(@Req() req: ActorRequest, @Param('orgId') orgId: string, @Param('projectId') projectId: string) { await this.policy.authorize(req.actor.id, uuid(orgId)); return this.db.chatThread.findMany({ where: { organizationId: orgId, projectId: uuid(projectId) }, orderBy: { createdAt: 'desc' }, take: 30, include: { messages: { orderBy: { createdAt: 'asc' }, take: 100 } } }); }
  @Post() @Throttle({ default: { limit: 6, ttl: 60_000 } }) async ask(@Req() req: ActorRequest, @Param('orgId') orgId: string, @Param('projectId') projectId: string, @Body() input: unknown) {
    await this.policy.authorize(req.actor.id, uuid(orgId), 'research');
    if (!req.actor.verified) throw new ForbiddenException('Verify your email first');
    await this.operations.requireFeature('copilot');
    const { question, threadId } = z.object({ question: z.string().trim().min(5).max(2000), threadId: z.uuid().optional() }).strict().parse(input);
    await this.db.project.findFirstOrThrow({ where: { id: uuid(projectId), organizationId: orgId, deletedAt: null } });
    if (threadId && !await this.db.chatThread.findFirst({ where: { id: threadId, organizationId: orgId, projectId } })) throw new NotFoundException('Conversation not found');
    const subscription = await this.db.subscription.findUnique({ where: { organizationId: orgId } });
    if (!hasActiveEntitlement(subscription)) throw new ForbiddenException('An active subscription or grace period is required');
    this.ai.assertConfigured();
    const terms = [...new Set(question.toLowerCase().match(/[a-z]{3,}/g) ?? [])].slice(0, 10);
    const semantic = await this.embeddings.retrieve(orgId, projectId, question);
    const sources = semantic ?? await this.db.source.findMany({ where: { organizationId: orgId, projectId, ...(terms.length ? { OR: terms.map(term => ({ text: { contains: term, mode: 'insensitive' as const } })) } : {}) }, orderBy: { retrievedAt: 'desc' }, take: 6, select: { id: true, url: true, title: true, text: true } });
    if (!sources.length) return { answer: 'No matching saved source evidence is available. Run research or refine your question.', citations: [], limitations: ['No relevant project evidence'], threadId: threadId ?? null };
    const history = threadId ? await this.db.chatMessage.findMany({ where: { organizationId: orgId, threadId }, orderBy: { createdAt: 'desc' }, take: 8 }) : [];
    const result = await this.ai.generate(copilotSchema, `${isolationPrompt} Answer from saved evidence only. If evidence is insufficient, explain the gap. Cite every factual claim.`, { question, history: history.reverse().map(m => ({ role: m.role, content: m.content })), sources: sources.map(s => ({ ...s, text: s.text.slice(0, 8000) })) }, { organizationId: orgId });
    for (const citation of result.data.citations) {
      const source = sources.find(s => s.id === citation.sourceId);
      if (!source || !source.text.replace(/\s+/g, ' ').toLowerCase().includes(citation.quotation.replace(/\s+/g, ' ').toLowerCase())) throw new ForbiddenException('Copilot response failed evidence validation');
    }
    if (!result.data.citations.length) throw new ForbiddenException('Copilot did not supply supporting evidence');
    const thread = await this.db.$transaction(async tx => {
      const org = await lockOrganization(tx, orgId);
      if (!hasActiveEntitlement(await tx.subscription.findUnique({ where: { organizationId: orgId } }))) throw new ForbiddenException('Subscription access expired');
      if (org.credits - org.reservedCredits < 2) throw new ForbiddenException('Insufficient credits');
      const thread = threadId ? await tx.chatThread.findFirstOrThrow({ where: { id: threadId, organizationId: orgId, projectId } }) : await tx.chatThread.create({ data: { organizationId: orgId, projectId, title: question.slice(0, 100) } });
      const message = await tx.chatMessage.create({ data: { organizationId: orgId, threadId: thread.id, role: 'user', content: question } });
      await tx.chatMessage.create({ data: { organizationId: orgId, threadId: thread.id, role: 'assistant', content: result.data.answer, citations: json(result.data.citations) } });
      await tx.organization.update({ where: { id: orgId }, data: { credits: { decrement: 2 } } });
      const ledger = await tx.creditLedger.create({ data: { organizationId: orgId, idempotencyKey: `chat-${message.id}`, kind: 'CONSUME', amount: -2, balanceAfter: org.credits - 2, referenceId: thread.id } });
      await tx.usageEvent.create({ data: { organizationId: orgId, ledgerId: ledger.id, category: 'COPILOT', units: 2, referenceId: thread.id } });
      return thread;
    });
    return { ...result.data, threadId: thread.id, retrievalMode: semantic ? 'semantic' : 'lexical', sources: sources.map(({ id, url, title }) => ({ id, url, title })) };
  }
}
