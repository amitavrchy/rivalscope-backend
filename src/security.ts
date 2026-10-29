import { CanActivate, Catch, ExceptionFilter, ArgumentsHost, HttpException, Injectable, Inject, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { ZodError } from 'zod';
import { Database } from './database.js';
import { env } from './config.js';
import { captureSanitizedError } from './instrumentation.js';

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');
export const SESSION_COOKIE = 'rs_session';
export type ActorRequest = Request & { actor: { id: string; email: string; verified: boolean; platformAdmin: boolean }; sessionId: string };
export const cookieOptions = { httpOnly: true, sameSite: 'lax' as const, secure: env.NODE_ENV === 'production', path: '/' };

export function originProtection(req: Request, res: Response, next: NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.path === '/api/billing/webhook') return next();
  if (req.headers.origin !== new URL(env.APP_ORIGIN).origin) return res.status(403).json({ message: 'Request origin is not allowed' });
  if (!req.is('application/json')) return res.status(415).json({ message: 'Use application/json' });
  next();
}

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(@Inject(Database) private readonly db: Database) {}
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<ActorRequest>();
    const token: unknown = (req.cookies as Record<string, unknown> | undefined)?.[SESSION_COOKIE];
    if (typeof token !== 'string' || token.length > 100) throw new UnauthorizedException('Sign in to continue');
    const session = await this.db.session.findUnique({ where: { tokenHash: hashToken(token) }, include: { user: true } });
    if (!session || session.expiresAt <= new Date() || session.user.deletedAt) throw new UnauthorizedException('Your session has expired');
    if (session.lastSeenAt.getTime() < Date.now() - 300000) await this.db.session.updateMany({ where: { id: session.id }, data: { lastSeenAt: new Date() } });
    req.actor = { id: session.user.id, email: session.user.email, verified: !!session.user.emailVerifiedAt, platformAdmin: session.user.platformAdmin };
    req.sessionId = session.id;
    return true;
  }
}

import { can } from './rbac.js';
import type { Permission } from './rbac.js';
export { can } from './rbac.js';
export type { Permission } from './rbac.js';

@Injectable()
export class TenantPolicy {
  constructor(@Inject(Database) private readonly db: Database) {}
  async authorize(userId: string, organizationId: string, permission: Permission = 'read') {
    const membership = await this.db.membership.findUnique({ where: { organizationId_userId: { organizationId, userId } } });
    if (!membership || !can(membership.role, permission)) throw new ForbiddenException('Workspace access denied');
    if (!await this.db.rolePermission.findFirst({where:{role:membership.role,permission:{key:permission}},select:{id:true}})) throw new ForbiddenException('This workspace permission is disabled by policy');
    return membership;
  }
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (error instanceof ZodError) return res.status(400).json({ message: 'Validation failed', issues: error.issues.map(i => ({ path: i.path.join('.'), message: i.message })) });
    if (error instanceof HttpException) return res.status(error.getStatus()).json({ message: error.message });
    const code = (error as { code?: string })?.code;
    if (code === 'P2002') return res.status(409).json({ message: 'This record already exists' });
    if (code === 'P2025') return res.status(404).json({ message: 'Record not found' });
    if (code === 'P2003') return res.status(400).json({ message: 'Related record is not available in this workspace' });
    // Never log raw provider/SQL errors: they can contain secrets and private content.
    captureSanitizedError(error);
    process.stderr.write(JSON.stringify({ level: 'error', event: 'request_failed', errorType: error instanceof Error ? error.constructor.name : 'Unknown' }) + '\n');
    return res.status(500).json({ message: 'An internal error occurred. Please try again.' });
  }
}
