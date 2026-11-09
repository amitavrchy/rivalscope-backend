import { planLimit } from './entitlements.js';
import { Body, Controller, Get, Inject, Injectable, Post, Req, Res, ServiceUnavailableException, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { Database } from './database.js';
import { MailService } from './mail.js';
import { cookieOptions, hashToken, newToken, SESSION_COOKIE, SessionGuard } from './security.js';
import type { ActorRequest } from './security.js';
import { env } from './config.js';
import { AccountSecurityService } from './account-security.js';

const email = z.email().max(254).transform(s => s.toLowerCase().trim());
const password = z.string().min(12).max(128);
export const registerSchema = z.object({ email, password, name: z.string().trim().min(2).max(80), organizationName: z.string().trim().min(2).max(100) }).strict();

@Injectable()
export class AuthService {
  constructor(@Inject(Database) private readonly db: Database, @Inject(MailService) private readonly mail: MailService, @Inject(AccountSecurityService) private readonly security: AccountSecurityService) {}
  async register(input: unknown) {
    const data = registerSchema.parse(input);
    if (env.FREE_PREVIEW === 'true' && !env.SMTP_URL) throw new ServiceUnavailableException('Email delivery is unavailable in this preview. Use the privately configured preview account.');
    const passwordHash = await argon2.hash(data.password, { type: argon2.argon2id });
    const token = newToken();
    const user = await this.db.$transaction(async tx => {
      const created = await tx.user.create({ data: { email: data.email, name: data.name, passwordHash } });
      const plan = await tx.plan.findUniqueOrThrow({ where: { id: 'free' }, include: { entitlements: true } });
      const org = await tx.organization.create({ data: {
        name: data.organizationName, slug: `${data.organizationName.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}-${randomUUID().slice(0, 8)}`,
        credits: planLimit(plan, 'monthlyCredits'), memberships: { create: { userId: created.id, role: 'OWNER' } }, subscription: { create: { planId: plan.id } },
      } });
      await tx.creditLedger.create({ data: { organizationId: org.id, kind: 'GRANT', amount: planLimit(plan, 'monthlyCredits'), balanceAfter: planLimit(plan, 'monthlyCredits'), idempotencyKey: `signup-${org.id}` } });
      await tx.verificationToken.create({ data: { userId: created.id, purpose: 'verify', tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 24 * 3600_000) } });
      await this.mail.enqueue(tx, data.email, 'Verify your RivalScope account', `Verify your email: ${env.APP_ORIGIN}/?verify=${token}\nThis link expires in 24 hours.`);
      return created;
    });
    return this.createSession(user.id);
  }
  async login(input: unknown) {
    const data = z.object({ email, password: z.string().max(128) }).strict().parse(input);
    const user = await this.db.user.findUnique({ where: { email: data.email } });
    // Perform a real hash even for absent accounts to reduce enumeration by timing.
    const valid = user ? await argon2.verify(user.passwordHash, data.password) : (await argon2.hash(data.password), false);
    if (!user || !valid || user.deletedAt) throw new UnauthorizedException('Email or password is incorrect');
    return this.security.challenge(user.id);
  }
  async createSession(userId: string) {
    const token = newToken();
    await this.db.session.create({ data: { userId, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 7 * 24 * 3600_000) } });
    return token;
  }
  async requestToken(input: unknown, purpose: 'reset' | 'verify') {
    const data = z.object({ email }).strict().parse(input);
    const user = await this.db.user.findUnique({ where: { email: data.email } });
    if (user && !user.deletedAt && !(purpose === 'verify' && user.emailVerifiedAt)) {
      const token = newToken();
      await this.db.$transaction(async tx => {
        await tx.verificationToken.updateMany({ where: { userId: user.id, purpose, usedAt: null }, data: { usedAt: new Date() } });
        await tx.verificationToken.create({ data: { userId: user.id, purpose, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 3600_000) } });
        await this.mail.enqueue(tx, user.email, purpose === 'reset' ? 'Reset your RivalScope password' : 'Verify your RivalScope account', `Open ${env.APP_ORIGIN}/?${purpose}=${token}\nThis link expires in one hour.`);
      });
    }
    return { message: 'If the account is eligible, an email will arrive shortly.' };
  }
  async consumeToken(input: unknown, purpose: 'reset' | 'verify') {
    const data = z.object({ token: z.string().min(40).max(100), password: purpose === 'reset' ? password : password.optional() }).strict().parse(input);
    const passwordHash = data.password ? await argon2.hash(data.password) : undefined;
    await this.db.$transaction(async tx => {
      const found = await tx.verificationToken.findUnique({ where: { tokenHash: hashToken(data.token) } });
      if (!found || found.purpose !== purpose || found.usedAt || found.expiresAt <= new Date()) throw new UnauthorizedException('The link is invalid or expired');
      const used = await tx.verificationToken.updateMany({ where: { id: found.id, usedAt: null }, data: { usedAt: new Date() } });
      if (!used.count) throw new UnauthorizedException('The link has already been used');
      await tx.user.update({ where: { id: found.userId }, data: purpose === 'verify' ? { emailVerifiedAt: new Date() } : { passwordHash } });
      if (purpose === 'reset') await tx.session.deleteMany({ where: { userId: found.userId } });
    });
    return { message: purpose === 'verify' ? 'Email verified' : 'Password updated. Sign in again.' };
  }
}

@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(Database) private readonly db: Database, @Inject(AccountSecurityService) private readonly security: AccountSecurityService) {}
  private setCookie(res: Response, token: string) { res.cookie(SESSION_COOKIE, token, { ...cookieOptions, maxAge: 7 * 24 * 3600_000 }); return { message: 'Signed in' }; }
  @Post('register') @Throttle({ default: { limit: 10, ttl: 60_000 } }) async register(@Body() input: unknown, @Res({ passthrough: true }) res: Response) { return this.setCookie(res, await this.auth.register(input)); }
  @Post('login') @Throttle({ default: { limit: 10, ttl: 60_000 } }) async login(@Body() input: unknown, @Res({ passthrough: true }) res: Response) { const result = await this.auth.login(input); return typeof result === 'string' ? this.setCookie(res, result) : result; }
  @Post('mfa') @Throttle({ default: { limit: 10, ttl: 60_000 } }) async mfa(@Body() input: unknown, @Res({ passthrough: true }) res: Response) { return this.setCookie(res, await this.security.completeChallenge(input)); }
  @Post('forgot-password') @Throttle({ default: { limit: 5, ttl: 60_000 } }) requestReset(@Body() input: unknown) { return this.auth.requestToken(input, 'reset'); }
  @Post('resend-verification') @Throttle({ default: { limit: 5, ttl: 60_000 } }) requestVerify(@Body() input: unknown) { return this.auth.requestToken(input, 'verify'); }
  @Post('reset-password') @Throttle({ default: { limit: 10, ttl: 60_000 } }) reset(@Body() input: unknown) { return this.auth.consumeToken(input, 'reset'); }
  @Post('verify') @Throttle({ default: { limit: 10, ttl: 60_000 } }) verify(@Body() input: unknown) { return this.auth.consumeToken(input, 'verify'); }
  @Get('me') @UseGuards(SessionGuard) async me(@Req() req: ActorRequest) {
    return this.db.user.findUniqueOrThrow({ where: { id: req.actor.id }, select: { id: true, name: true, email: true, emailVerifiedAt: true, platformAdmin: true, memberships: { select: { role: true, organization: { select: { id: true, name: true, slug: true } } } } } });
  }
  @Post('refresh') @UseGuards(SessionGuard) async refresh(@Req() req: ActorRequest, @Res({ passthrough: true }) res: Response) {
    const token = newToken();
    await this.db.session.update({ where: { id: req.sessionId }, data: { tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 7 * 24 * 3600_000) } });
    return this.setCookie(res, token);
  }
  @Post('logout') @UseGuards(SessionGuard) async logout(@Req() req: ActorRequest, @Res({ passthrough: true }) res: Response) {
    await this.db.session.deleteMany({ where: { id: req.sessionId } }); res.clearCookie(SESSION_COOKIE, cookieOptions); return { message: 'Signed out' };
  }
  @Post('logout-all') @UseGuards(SessionGuard) async logoutAll(@Req() req: ActorRequest, @Res({ passthrough: true }) res: Response) {
    await this.db.session.deleteMany({ where: { userId: req.actor.id } }); res.clearCookie(SESSION_COOKIE, cookieOptions); return { message: 'All sessions revoked' };
  }
}
