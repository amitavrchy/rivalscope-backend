import { BadRequestException, Body, Controller, Get, Inject, Injectable, Param, Post, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { Database } from './database.js';
import { SessionGuard, TenantPolicy } from './security.js';
import type { ActorRequest } from './security.js';
import type { Prisma } from './generated/prisma/client.js';

const evidence = { domain: z.string().min(3).max(253), sourceId: z.uuid(), quotation: z.string().min(20).max(600) };
export const catalogSchema = z.object({
  products: z.array(z.object({ ...evidence, name: z.string().min(1).max(150), description: z.string().max(800) })).max(20),
  features: z.array(z.object({ ...evidence, name: z.string().min(2).max(100) })).max(40),
  prices: z.array(z.object({ ...evidence, name: z.string().min(1).max(100), amount: z.number().min(0).max(100000000).nullable(), currency: z.string().regex(/^[A-Z]{3}$/).nullable(), interval: z.enum(['MONTH','YEAR','ONE_TIME','USAGE','CUSTOM']).nullable() })).max(30),
});
export const verificationSchema = z.object({ items: z.array(z.object({ index: z.number().int().min(0), supported: z.boolean(), reason: z.string().min(3).max(400) })).max(40) });
type Catalog = z.infer<typeof catalogSchema>;
type CatalogSource = { id: string; url: string; text: string };
const normalize = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase();
export function validateCatalog(catalog: Catalog, sources: CatalogSource[], domains: string[]) {
  for (const item of [...catalog.products, ...catalog.features, ...catalog.prices]) {
    const source = sources.find(s => s.id === item.sourceId); const domain = item.domain.toLowerCase();
    if (!source || !domains.includes(domain) || !normalize(source.text).includes(normalize(item.quotation))) throw new Error('Catalog evidence is unavailable or does not contain the quotation');
    const host = new URL(source.url).hostname.replace(/^www\./, '');
    if (host !== domain.replace(/^www\./, '') && !host.endsWith(`.${domain}`)) throw new Error('Catalog fields require evidence from the competitor’s own public domain');
  }
  for (const price of catalog.prices) {
    if (price.amount !== null) {
      const quotedNumbers = price.quotation.replaceAll(',', '').match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
      if (!quotedNumbers.includes(price.amount)) throw new Error('Catalog price amount is not present in the quoted evidence');
    }
  }
  return catalog;
}
@Injectable()
export class IntelligenceService {
  constructor(@Inject(Database) private readonly db: Database) {}
  async persist(tx: Prisma.TransactionClient, organizationId: string, projectId: string, catalog: Catalog, sources: CatalogSource[]) {
    const competitors = await tx.competitor.findMany({ where: { organizationId, projectId } });
    for (const product of catalog.products) {
      const competitor = competitors.find(c => c.domain === product.domain.toLowerCase()); const source = sources.find(s => s.id === product.sourceId);
      if (competitor && source) await tx.competitorProduct.create({ data: { organizationId, competitorId: competitor.id, name: product.name, description: product.description, sourceUrl: source.url } });
    }
    for (const item of catalog.features) {
      const competitor = competitors.find(c => c.domain === item.domain.toLowerCase()); if (!competitor) continue;
      const feature = await tx.feature.upsert({ where: { organizationId_normalizedName: { organizationId, normalizedName: normalize(item.name) } }, create: { organizationId, name: item.name, normalizedName: normalize(item.name) }, update: {} });
      await tx.competitorFeature.upsert({ where: { organizationId_competitorId_featureId: { organizationId, competitorId: competitor.id, featureId: feature.id } }, create: { organizationId, competitorId: competitor.id, featureId: feature.id, sourceId: item.sourceId, quotation: item.quotation }, update: { sourceId: item.sourceId, quotation: item.quotation, observedAt: new Date() } });
    }
    for (const price of catalog.prices) {
      const competitor = competitors.find(c => c.domain === price.domain.toLowerCase()); const source = sources.find(s => s.id === price.sourceId); if (!competitor || !source) continue;
      const plan = await tx.pricingPlan.upsert({ where: { organizationId_competitorId_name: { organizationId, competitorId: competitor.id, name: price.name } }, create: { organizationId, competitorId: competitor.id, name: price.name, amount: price.amount, currency: price.currency, interval: price.interval, sourceUrl: source.url }, update: { amount: price.amount, currency: price.currency, interval: price.interval, sourceUrl: source.url, retrievedAt: new Date() } });
      await tx.pricingHistory.create({ data: { organizationId, pricingPlanId: plan.id, amount: price.amount, currency: price.currency, interval: price.interval, sourceUrl: source.url } });
    }
  }
}
@Controller('organizations/:orgId/projects/:projectId/intelligence')
@UseGuards(SessionGuard)
export class IntelligenceController {
  constructor(@Inject(Database) private readonly db: Database, @Inject(TenantPolicy) private readonly policy: TenantPolicy) {}
  @Get() async get(@Req() req: ActorRequest, @Param('orgId') orgId: string, @Param('projectId') projectId: string) {
    await this.policy.authorize(req.actor.id, z.uuid().parse(orgId));
    await this.db.project.findFirstOrThrow({ where: { id: z.uuid().parse(projectId), organizationId: orgId, deletedAt: null } });
    const competitors = await this.db.competitor.findMany({ where: { organizationId: orgId, OR: [{ projectId }, { projectLinks: { some: { organizationId: orgId, projectId } } }] }, include: { products: true, features: { include: { feature: true, source: { select: { id: true, url: true, title: true, retrievedAt: true } } } }, pricing: { include: { history: { orderBy: { retrievedAt: 'desc' }, take: 10 } } } } });
    const comparisons = await this.db.comparison.findMany({ where: { organizationId: orgId, projectId }, orderBy: { createdAt: 'desc' }, take: 30 });
    return { competitors, comparisons };
  }
  @Post('comparisons') async save(@Req() req: ActorRequest, @Param('orgId') orgId: string, @Param('projectId') projectId: string, @Body() input: unknown) {
    await this.policy.authorize(req.actor.id, z.uuid().parse(orgId), 'edit'); z.uuid().parse(projectId);
    const data = z.object({ name: z.string().trim().min(2).max(100), competitorIds: z.array(z.uuid()).min(1).max(8) }).strict().parse(input);
    const ids = [...new Set(data.competitorIds)]; const count = await this.db.competitor.count({ where: { id: { in: ids }, organizationId: orgId, projectId } });
    if (count !== ids.length) throw new BadRequestException('Comparison includes an unavailable competitor');
    return this.db.comparison.create({ data: { organizationId: orgId, projectId, name: data.name, competitorIds: ids } });
  }
}
