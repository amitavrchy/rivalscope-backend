import { planLimit } from './entitlements.js';
import { Body, Controller, Get, Inject, Injectable, Post, Query, Req, Res, ServiceUnavailableException, UnauthorizedException, UseGuards } from '@nestjs/common';
import { OAuth2Client, CodeChallengeMethod } from 'google-auth-library';
import argon2 from 'argon2';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { Database } from './database.js';
import { env } from './config.js';
import { cookieOptions, hashToken, newToken, SessionGuard, SESSION_COOKIE } from './security.js';
import type { ActorRequest } from './security.js';
import { decrypt, encrypt } from './encryption.js';
import { AccountSecurityService } from './account-security.js';

const OAUTH_COOKIE = 'rs_oauth_state';
export function googleConfigured() { return !!env.GOOGLE_OAUTH_CLIENT_ID && !!env.GOOGLE_OAUTH_CLIENT_SECRET; }
@Injectable()
export class GoogleAuthService {
  constructor(@Inject(Database) private readonly db: Database, @Inject(AccountSecurityService) private readonly security: AccountSecurityService) {}
  client() {
    if (!googleConfigured()) throw new ServiceUnavailableException('Google sign-in requires GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET');
    return new OAuth2Client({ clientId: env.GOOGLE_OAUTH_CLIENT_ID, clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET, redirectUri: `${env.APP_ORIGIN}/api/auth/google/callback` });
  }
  async start(linkUserId?: string) {
    const client = this.client(); const state = newToken(); const nonce = newToken(); const pkce = await client.generateCodeVerifierAsync();
    await this.db.oAuthState.create({ data: { stateHash: hashToken(state), nonceHash: hashToken(nonce), encryptedVerifier: encrypt(pkce.codeVerifier), linkUserId, expiresAt: new Date(Date.now() + 600000) } });
    const url = client.generateAuthUrl({ scope: ['openid', 'email', 'profile'], state, nonce, code_challenge: pkce.codeChallenge, code_challenge_method: CodeChallengeMethod.S256, prompt: 'select_account' });
    return { state, url };
  }
  async callback(query: unknown, cookie: unknown) {
    const { code, state } = z.object({ code: z.string().min(1).max(4096), state: z.string().min(40).max(100) }).parse(query);
    if (cookie !== state) throw new UnauthorizedException('Google sign-in state mismatch');
    const stored = await this.db.oAuthState.findUnique({ where: { stateHash: hashToken(state) } });
    if (!stored || stored.expiresAt <= new Date()) throw new UnauthorizedException('Google sign-in expired');
    const consumed = await this.db.oAuthState.deleteMany({ where: { id: stored.id } });
    if (!consumed.count) throw new UnauthorizedException('Google sign-in already used');
    const client = this.client();
    const { tokens } = await client.getToken({ code, codeVerifier: decrypt(stored.encryptedVerifier) });
    if (!tokens.id_token) throw new UnauthorizedException('Google did not return an identity token');
    const payload = (await client.verifyIdToken({ idToken: tokens.id_token, audience: env.GOOGLE_OAUTH_CLIENT_ID })).getPayload();
    if (!payload?.email || !payload.email_verified || !payload.sub || hashToken(String(payload.nonce)) !== stored.nonceHash) throw new UnauthorizedException('Google identity verification failed');
    const providerUserId = payload.sub; const email = payload.email.toLowerCase();
    const existing = await this.db.oAuthAccount.findUnique({ where: { provider_providerUserId: { provider: 'google', providerUserId } }, include: { user: true } });
    let userId: string;
    if (stored.linkUserId) {
      const user = await this.db.user.findUniqueOrThrow({ where: { id: stored.linkUserId } });
      if (user.deletedAt || user.email !== email || existing && existing.userId !== user.id) throw new UnauthorizedException('Google account must match your verified account email');
      await this.db.oAuthAccount.upsert({ where: { userId_provider: { userId: user.id, provider: 'google' } }, create: { userId: user.id, provider: 'google', providerUserId }, update: { providerUserId } });
      return { linked: true as const };
    } else if (existing) {
      if (existing.user.deletedAt) throw new UnauthorizedException('Account is unavailable'); userId = existing.userId;
    } else {
      // Never silently attach Google to an existing password account based only on its email.
      if (await this.db.user.findUnique({ where: { email } })) throw new UnauthorizedException('Sign in with your password, then connect Google in Settings');
      const passwordHash = await argon2.hash(newToken());
      userId = await this.db.$transaction(async tx => {
        const user = await tx.user.create({ data: { email, name: payload.name?.slice(0, 80) || email.split('@')[0]!, passwordHash, emailVerifiedAt: new Date(), oauthAccounts: { create: { provider: 'google', providerUserId } } } });
        const plan = await tx.plan.findUniqueOrThrow({ where: { id: 'free' }, include: { entitlements: true } });
        const org = await tx.organization.create({ data: { name: `${user.name}'s workspace`, slug: newToken().slice(0, 24), credits: planLimit(plan, 'monthlyCredits'), memberships: { create: { userId: user.id, role: 'OWNER' } }, subscription: { create: { planId: plan.id } } } });
        await tx.creditLedger.create({ data: { organizationId: org.id, kind: 'GRANT', amount: planLimit(plan, 'monthlyCredits'), balanceAfter: org.credits, idempotencyKey: `signup-${org.id}` } }); return user.id;
      });
    }
    return this.security.challenge(userId);
  }
}

@Controller('auth/google')
export class GoogleAuthController {
  constructor(@Inject(GoogleAuthService) private readonly google: GoogleAuthService, @Inject(AccountSecurityService) private readonly security: AccountSecurityService) {}
  @Get('status') status() { return { configured: googleConfigured() }; }
  private cookie(res: Response, state: string) { res.cookie(OAUTH_COOKIE, state, { ...cookieOptions, path: '/api/auth/google', maxAge: 600000 }); }
  @Get('start') async start(@Res() res: Response) { const result = await this.google.start(); this.cookie(res, result.state); return res.redirect(result.url); }
  @Post('link') @UseGuards(SessionGuard) async link(@Req() req: ActorRequest, @Body() input: unknown, @Res({ passthrough: true }) res: Response) {
    await this.security.reauthenticate(req.actor.id, input); const result = await this.google.start(req.actor.id); this.cookie(res, result.state); return { url: result.url };
  }
  @Get('callback') async callback(@Query() query: unknown, @Req() req: Request, @Res() res: Response) {
    try {
      const result = await this.google.callback(query, (req.cookies as Record<string, unknown>)[OAUTH_COOKIE]);
      res.clearCookie(OAUTH_COOKIE, { ...cookieOptions, path: '/api/auth/google' });
      if (typeof result === 'string') { res.cookie(SESSION_COOKIE, result, { ...cookieOptions, maxAge: 7 * 86400_000 }); return res.redirect(`${env.APP_ORIGIN}/workspace/overview`); }
      if ('linked' in result) return res.redirect(`${env.APP_ORIGIN}/workspace/settings?google=linked`);
      // Fragment is not sent to the server or in referrer headers; the login page consumes it in memory.
      return res.redirect(`${env.APP_ORIGIN}/login#mfa=${encodeURIComponent(result.challenge)}`);
    } catch { return res.redirect(`${env.APP_ORIGIN}/login?google=failed`); }
  }
}
