import { Body, Controller, Delete, ForbiddenException, Get, Inject, Injectable, Param, Patch, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import argon2 from 'argon2';
import { generateSecret, generateURI, verify } from 'otplib';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { Database } from './database.js';
import { decrypt, encrypt } from './encryption.js';
import { hashToken, newToken, SessionGuard } from './security.js';
import type { ActorRequest } from './security.js';
import type { Prisma } from './generated/prisma/client.js';

export const reauthentication = z.object({ password: z.string().min(1).max(128), code: z.string().trim().max(80).optional() });
@Injectable()
export class AccountSecurityService {
  constructor(@Inject(Database) private readonly db: Database) {}
  async password(userId: string, password: string) {
    const user = await this.db.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.deletedAt || !await argon2.verify(user.passwordHash, password)) throw new UnauthorizedException('Your current password is incorrect');
    return user;
  }
  async factor(tx: Prisma.TransactionClient, userId: string, code = '') {
    const factor = await tx.mFAFactor.findUnique({ where: { userId } });
    if (!factor?.enabledAt) return;
    if (/^\d{6}$/.test(code)) {
      const result = await verify({ secret: decrypt(factor.encryptedSecret), token: code, epochTolerance: [30, 0], afterTimeStep: Number(factor.lastUsedStep) });
      if (!result.valid || !('timeStep' in result)) throw new UnauthorizedException('Authenticator code is invalid or already used');
      const changed = await tx.mFAFactor.updateMany({ where: { id: factor.id, lastUsedStep: factor.lastUsedStep }, data: { lastUsedStep: BigInt(result.timeStep) } });
      if (!changed.count) throw new UnauthorizedException('Authenticator code was already used');
    } else {
      const used = await tx.recoveryCode.updateMany({ where: { userId, codeHash: hashToken(code.replaceAll('-', '').toLowerCase()), usedAt: null }, data: { usedAt: new Date() } });
      if (!used.count) throw new UnauthorizedException('A valid authenticator or unused recovery code is required');
    }
  }
  async reauthenticate(userId: string, input: unknown) {
    const data = reauthentication.parse(input); await this.password(userId, data.password);
    await this.db.$transaction(tx => this.factor(tx, userId, data.code));
  }
  async challenge(userId: string): Promise<string | { mfaRequired: true; challenge: string }> {
    const factor = await this.db.mFAFactor.findUnique({ where: { userId } });
    const token = newToken();
    if (!factor?.enabledAt) {
      await this.db.session.create({ data: { userId, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 7 * 86400_000) } }); return token;
    }
    await this.db.loginChallenge.create({ data: { userId, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 5 * 60_000) } });
    return { mfaRequired: true, challenge: token };
  }
  async completeChallenge(input: unknown) {
    const data = z.object({ challenge: z.string().min(40).max(100), code: z.string().trim().min(6).max(80) }).strict().parse(input);
    const challenge = await this.db.loginChallenge.findUnique({ where: { tokenHash: hashToken(data.challenge) } });
    if (!challenge) throw new UnauthorizedException('Login challenge is invalid or expired');
    const attempt = await this.db.loginChallenge.updateMany({ where: { id: challenge.id, usedAt: null, attempts: { lt: 5 }, expiresAt: { gt: new Date() } }, data: { attempts: { increment: 1 } } });
    if (!attempt.count) throw new UnauthorizedException('Login challenge expired. Sign in again.');
    const token = newToken();
    await this.db.$transaction(async tx => {
      const user = await tx.user.findUniqueOrThrow({ where: { id: challenge.userId } });
      if (user.deletedAt) throw new UnauthorizedException();
      await this.factor(tx, user.id, data.code);
      const used = await tx.loginChallenge.updateMany({ where: { id: challenge.id, usedAt: null }, data: { usedAt: new Date() } });
      if (!used.count) throw new UnauthorizedException('Login challenge was already used');
      await tx.session.create({ data: { userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 7 * 86400_000) } });
    }); return token;
  }
  async codes(tx: Prisma.TransactionClient, userId: string) {
    const codes = Array.from({ length: 10 }, () => randomBytes(10).toString('hex'));
    await tx.recoveryCode.deleteMany({ where: { userId } });
    await tx.recoveryCode.createMany({ data: codes.map(code => ({ userId, codeHash: hashToken(code) })) });
    return codes.map(code => code.match(/.{1,5}/g)!.join('-'));
  }
}

@Controller('account')
@UseGuards(SessionGuard)
export class AccountController {
  constructor(@Inject(Database) private readonly db: Database, @Inject(AccountSecurityService) private readonly security: AccountSecurityService) {}
  @Get('security') async status(@Req() req: ActorRequest) {
    const [factor, sessions, oauthAccounts, recoveryCodesRemaining] = await Promise.all([
      this.db.mFAFactor.findUnique({ where: { userId: req.actor.id }, select: { enabledAt: true } }),
      this.db.session.findMany({ where: { userId: req.actor.id, expiresAt: { gt: new Date() } }, select: { id: true, label: true, createdAt: true, lastSeenAt: true, expiresAt: true }, orderBy: { createdAt: 'desc' } }),
      this.db.oAuthAccount.findMany({ where: { userId: req.actor.id }, select: { provider: true } }), this.db.recoveryCode.count({ where: { userId: req.actor.id, usedAt: null } }),
    ]); return { mfaEnabled: !!factor?.enabledAt, recoveryCodesRemaining, oauthAccounts, sessions: sessions.map(s => ({ ...s, current: s.id === req.sessionId })) };
  }
  @Patch('profile') async profile(@Req() req: ActorRequest, @Body() input: unknown) {
    const data = z.object({ name: z.string().trim().min(2).max(80) }).strict().parse(input);
    return this.db.user.update({ where: { id: req.actor.id }, data, select: { id: true, name: true, email: true } });
  }
  @Delete('sessions/:id') async revoke(@Req() req: ActorRequest, @Param('id') id: string) { await this.db.session.deleteMany({ where: { id: z.uuid().parse(id), userId: req.actor.id } }); return { message: 'Session revoked' }; }
  @Post('mfa/setup') @Throttle({ default: { limit: 5, ttl: 60000 } }) async setup(@Req() req: ActorRequest, @Body() input: unknown) {
    if (!req.actor.verified) throw new ForbiddenException('Verify your email before enabling MFA');
    await this.security.reauthenticate(req.actor.id, input);
    const secret = generateSecret();
    await this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${req.actor.id}::uuid FOR UPDATE`;
      const existing = await tx.mFAFactor.findUnique({ where: { userId: req.actor.id } });
      if (existing?.enabledAt) throw new ForbiddenException('MFA is already enabled');
      await tx.mFAFactor.upsert({ where: { userId: req.actor.id }, create: { userId: req.actor.id, encryptedSecret: encrypt(secret) }, update: { encryptedSecret: encrypt(secret), createdAt: new Date(), lastUsedStep: 0 } });
    });
    return { secret, uri: generateURI({ issuer: 'RivalScope AI', label: req.actor.email, secret }), message: 'Add this key to your authenticator, then confirm a code. Setup expires in ten minutes.' };
  }
  @Post('mfa/enable') @Throttle({ default: { limit: 5, ttl: 60000 } }) async enable(@Req() req: ActorRequest, @Body() input: unknown) {
    const data = reauthentication.extend({ code: z.string().regex(/^\d{6}$/) }).strict().parse(input);
    await this.security.password(req.actor.id, data.password);
    const recoveryCodes = await this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${req.actor.id}::uuid FOR UPDATE`;
      const factor = await tx.mFAFactor.findUnique({ where: { userId: req.actor.id } });
      if (!factor || factor.enabledAt || factor.createdAt.getTime() < Date.now() - 600000) throw new ForbiddenException('MFA setup is missing or expired');
      const result = await verify({ secret: decrypt(factor.encryptedSecret), token: data.code, epochTolerance: [30, 0] });
      if (!result.valid || !('timeStep' in result)) throw new UnauthorizedException('Authenticator code is incorrect');
      await tx.mFAFactor.update({ where: { id: factor.id }, data: { enabledAt: new Date(), lastUsedStep: BigInt(result.timeStep) } });
      await tx.session.deleteMany({ where: { userId: req.actor.id, id: { not: req.sessionId } } });
      return this.security.codes(tx, req.actor.id);
    }); return { recoveryCodes, message: 'MFA enabled. Store these single-use recovery codes safely; they are shown only now.' };
  }
  @Post('mfa/recovery-codes') @Throttle({ default: { limit: 5, ttl: 60000 } }) async recovery(@Req() req: ActorRequest, @Body() input: unknown) {
    await this.security.reauthenticate(req.actor.id, input);
    if (!(await this.db.mFAFactor.findUnique({ where: { userId: req.actor.id } }))?.enabledAt) throw new ForbiddenException('Enable MFA first');
    return { recoveryCodes: await this.db.$transaction(tx => this.security.codes(tx, req.actor.id)), message: 'Old recovery codes have been replaced' };
  }
  @Post('mfa/disable') @Throttle({ default: { limit: 5, ttl: 60000 } }) async disable(@Req() req: ActorRequest, @Body() input: unknown) {
    await this.security.reauthenticate(req.actor.id, input);
    await this.db.$transaction(async tx => { await tx.mFAFactor.deleteMany({ where: { userId: req.actor.id } }); await tx.recoveryCode.deleteMany({ where: { userId: req.actor.id } }); await tx.session.deleteMany({ where: { userId: req.actor.id, id: { not: req.sessionId } } }); });
    return { message: 'MFA disabled; other sessions revoked' };
  }
}
