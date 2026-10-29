import { Controller, Get, Inject, NotFoundException, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { Database } from './database.js';
import { SessionGuard, TenantPolicy } from './security.js';
import type { ActorRequest } from './security.js';
import { uuid } from './organizations.js';
import { analysisSchema } from './research-schemas.js';
import { renderDocx, renderPdf } from './report-renderer.js';
import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';

@Controller('organizations/:orgId/reports')
@UseGuards(SessionGuard)
export class ReportsController {
  constructor(@Inject(Database) private readonly db: Database, @Inject(TenantPolicy) private readonly policy: TenantPolicy) {}
  @Get(':id/exports') async history(@Req() req: ActorRequest, @Param('orgId') orgId: string, @Param('id') id: string) {
    await this.policy.authorize(req.actor.id, uuid(orgId)); await this.db.report.findFirstOrThrow({ where: { id: uuid(id), organizationId: orgId, project: { deletedAt: null }, run: { status: 'COMPLETED' } } });
    return this.db.reportExport.findMany({ where: { organizationId: orgId, reportId: id }, orderBy: { createdAt: 'desc' }, take: 100 });
  }
  @Get() async list(@Req() req: ActorRequest, @Param('orgId') orgId: string) { await this.policy.authorize(req.actor.id, uuid(orgId)); return this.db.report.findMany({ where: { organizationId: orgId, project: { deletedAt: null }, run: { status: 'COMPLETED' } }, orderBy: { createdAt: 'desc' }, take: 100, select: { id: true, title: true, projectId: true, runId: true, createdAt: true } }); }
  @Get(':id/export') async export(@Req() req: ActorRequest, @Param('orgId') orgId: string, @Param('id') id: string, @Query('format') format: string = 'json', @Res() res: Response) {
    await this.policy.authorize(req.actor.id, uuid(orgId));
    const report = await this.db.report.findFirst({ where: { id: uuid(id), organizationId: orgId, project: { deletedAt: null }, run: { status: 'COMPLETED' } } });
    if (!report) throw new NotFoundException('Report not found');
    const sources = await this.db.source.findMany({ where: { organizationId: orgId, runId: report.runId }, select: { id: true, url: true, title: true, contentHash: true, retrievedAt: true } });
    if (!['json', 'markdown', 'pdf', 'docx'].includes(format)) throw new BadRequestException('Choose json, markdown, pdf or docx');
    res.setHeader('Cache-Control', 'private, no-store');
    const record = async (data: string | Buffer) => { const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data); const record = await this.db.reportExport.create({ data: { organizationId: orgId, reportId: id, actorId: req.actor.id, format, bytes: bytes.length, contentHash: createHash('sha256').update(bytes).digest('hex') } }); res.setHeader('X-RivalScope-Export-ID', record.id); };
    if (format === 'json') { const data = { ...report, sources }; await record(JSON.stringify(data)); return res.setHeader('Content-Disposition', `attachment; filename="rivalscope-${id}.json"`).json(data); }
    const content = analysisSchema.parse(report.content);
    if (format === 'pdf' || format === 'docx') {
      const sections = [{ heading: 'Executive summary (AI interpretation)', text: content.executiveSummary }, ...content.findings.map(f => ({ heading: `${f.category} | ${f.kind}`, text: `${f.claim}\n\n${f.citations.map(c => `Evidence: ${c.quotation}\nSource: ${sources.find(s => s.id === c.sourceId)?.url || 'Unavailable'}`).join('\n\n')}` })), { heading: 'Evidence limitations', text: content.limitations.join('\n') }, { heading: 'Source methodology', text: `Generated ${report.createdAt.toISOString()}. Quotations are matched against extracted text; this is not independent semantic verification.\n${sources.map(s => `${s.title}\n${s.url}\nRetrieved ${s.retrievedAt.toISOString()} | SHA256 ${s.contentHash}`).join('\n\n')}` }];
      const data = format === 'pdf' ? await renderPdf(report.title, sections) : await renderDocx(report.title, sections);
      await record(data);
      return res.type(format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document').attachment(`rivalscope-${id}.${format}`).send(data);
    }
    const markdown = [`# ${report.title}`, `Generated ${report.createdAt.toISOString()}`, 'AI interpretation. Verify material decisions against the cited public sources.', '## Executive summary (inference)', content.executiveSummary,
      ...content.findings.flatMap(f => [`## ${f.category} · ${f.kind}`, f.claim, ...f.citations.map(c => `> ${c.quotation}\n\nSource: ${sources.find(s => s.id === c.sourceId)?.url ?? 'Unavailable'}`)]),
      '## Limitations', ...content.limitations.map(s => `- ${s}`), '## Sources', ...sources.map(s => `- ${s.title}: ${s.url} (retrieved ${s.retrievedAt.toISOString()}, SHA256 ${s.contentHash})`)].join('\n\n');
    await record(markdown); return res.type('text/markdown').setHeader('Content-Disposition', `attachment; filename="rivalscope-${id}.md"`).send(markdown);
  }
}
