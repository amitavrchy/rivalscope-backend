import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { generate } from 'otplib';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/bootstrap.js';
import { Database } from '../src/database.js';
import { RedisStore } from '../src/redis-store.js';
import { AccountSecurityService } from '../src/account-security.js';
import { GoogleAuthService } from '../src/google-auth.js';
import { OAuth2Client, LoginTicket } from 'google-auth-library';
import { env } from '../src/config.js';

describe('account security and privacy', () => {
  let app: INestApplication; let db: Database; let cookie: string; let userId: string; let orgId: string; let secret: string; let recoveryCodes: string[];
  const suffix = randomUUID(); const email = `security-${suffix}@example.test`; const password = 'a-unique-security-password-123';
  const headers = () => ({ Cookie: cookie, Origin: env.APP_ORIGIN });
  beforeAll(async () => {
    if (!new URL(env.DATABASE_URL).pathname.endsWith('/rivalscope_test')) throw new Error('Use the isolated test database');
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile(); app = configureApp(module.createNestApplication()); await app.init(); db = app.get(Database);
    const redis = app.get(RedisStore); const keys = await redis.client.keys('rs:throttle:*'); if (keys.length) await redis.client.del(...keys);
    const response = await request(app.getHttpServer()).post('/api/auth/register').set('Origin', env.APP_ORIGIN).send({ name: 'Security Analyst', email, password, organizationName: 'Security fixture workspace' }).expect(201);
    cookie = String(response.headers['set-cookie'][0]).split(';')[0]!;
    const me = await request(app.getHttpServer()).get('/api/auth/me').set('Cookie', cookie).expect(200); userId = me.body.id; orgId = me.body.memberships[0].organization.id;
    await db.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
  });
  afterAll(async () => { if (app) await app.close(); });
  it('requires a current password before MFA setup and encrypts the factor', async () => {
    await request(app.getHttpServer()).post('/api/account/mfa/setup').set(headers()).send({ password: 'wrong' }).expect(401);
    const setup = await request(app.getHttpServer()).post('/api/account/mfa/setup').set(headers()).send({ password }).expect(201); secret = setup.body.secret;
    expect(setup.body.uri).toMatch(/^otpauth:\/\/totp/);
    const factor = await db.mFAFactor.findUniqueOrThrow({ where: { userId } }); expect(factor.encryptedSecret).not.toContain(secret);
    expect(factor.enabledAt).toBeNull();
  });
  it('enables MFA only after a valid code and hashes recovery codes', async () => {
    const code = await generate({ secret }); const response = await request(app.getHttpServer()).post('/api/account/mfa/enable').set(headers()).send({ password, code }).expect(201);
    recoveryCodes = response.body.recoveryCodes; expect(recoveryCodes).toHaveLength(10);
    const stored = await db.recoveryCode.findFirstOrThrow({ where: { userId } }); expect(recoveryCodes).not.toContain(stored.codeHash);
    await expect(db.$transaction(tx => app.get(AccountSecurityService).factor(tx, userId, code))).rejects.toThrow('already used');
  });
  it('requires a second factor after password authentication and accepts a recovery code once', async () => {
    const first = await request(app.getHttpServer()).post('/api/auth/login').set('Origin', env.APP_ORIGIN).send({ email, password }).expect(201);
    expect(first.body.mfaRequired).toBe(true); expect(first.headers['set-cookie']).toBeUndefined();
    const login = await request(app.getHttpServer()).post('/api/auth/mfa').set('Origin', env.APP_ORIGIN).send({ challenge: first.body.challenge, code: recoveryCodes[0] }).expect(201);
    const session = String(login.headers['set-cookie'][0]).split(';')[0]!;
    await request(app.getHttpServer()).get('/api/auth/me').set('Cookie', session).expect(200);
    await request(app.getHttpServer()).post('/api/auth/mfa').set('Origin', env.APP_ORIGIN).send({ challenge: first.body.challenge, code: recoveryCodes[1] }).expect(401);
    const second = await request(app.getHttpServer()).post('/api/auth/login').set('Origin', env.APP_ORIGIN).send({ email, password }).expect(201);
    await request(app.getHttpServer()).post('/api/auth/mfa').set('Origin', env.APP_ORIGIN).send({ challenge: second.body.challenge, code: recoveryCodes[0] }).expect(401);
  });
  it('can update the profile, exports no password or factor secrets, and lists revocable sessions', async () => {
    await request(app.getHttpServer()).patch('/api/account/profile').set(headers()).send({ name: 'Updated Security Analyst' }).expect(200);
    const exported = await request(app.getHttpServer()).get('/api/privacy/account/export').set('Cookie', cookie).expect(200);
    expect(exported.body.account.name).toBe('Updated Security Analyst'); expect(JSON.stringify(exported.body)).not.toContain(secret); expect(exported.body.account.passwordHash).toBeUndefined();
    const sessions = await request(app.getHttpServer()).get('/api/account/security').set('Cookie', cookie).expect(200);
    const other = sessions.body.sessions.find((s: { current: boolean }) => !s.current); expect(other).toBeTruthy();
    await request(app.getHttpServer()).delete(`/api/account/sessions/${other.id}`).set(headers()).send({}).expect(200);
    expect(await db.session.count({ where: { id: other.id } })).toBe(0);
  });
  it('rejects OAuth callback state mismatch before contacting Google', async () => {
    await expect(app.get(GoogleAuthService).callback({ state: 'x'.repeat(43), code: 'fixture' }, 'wrong')).rejects.toThrow('state mismatch');
  });
  it('enforces OIDC nonce, single-use state and explicit linking to an existing password account', async () => {
    const service = app.get(GoogleAuthService); const client = new OAuth2Client({ clientId: 'fixture-client' });
    const factory = vi.spyOn(service, 'client').mockReturnValue(client);
    const token = vi.spyOn(client, 'getToken').mockImplementation((async () => ({ tokens: { id_token: 'fixture-id-token' }, res: null })) as OAuth2Client['getToken']);
    let identity: LoginTicket; const verify = vi.spyOn(client, 'verifyIdToken').mockImplementation((async () => identity) as OAuth2Client['verifyIdToken']); const oldClientId = env.GOOGLE_OAUTH_CLIENT_ID; env.GOOGLE_OAUTH_CLIENT_ID = 'fixture-client';
    const ticket = (nonce: string) => new LoginTicket('fixture', { iss: 'https://accounts.google.com', aud: 'fixture-client', sub: `google-${suffix}`, iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600, email, email_verified: true, nonce });
    try {
      const invalid = await service.start(); identity = ticket('wrong-nonce');
      await expect(service.callback({ code: 'fixture', state: invalid.state }, invalid.state)).rejects.toThrow('verification');
      const existing = await service.start(); identity = ticket(new URL(existing.url).searchParams.get('nonce')!);
      await expect(service.callback({ code: 'fixture', state: existing.state }, existing.state)).rejects.toThrow('connect Google');
      const link = await service.start(userId); identity = ticket(new URL(link.url).searchParams.get('nonce')!);
      expect(await service.callback({ code: 'fixture', state: link.state }, link.state)).toEqual({ linked: true });
      await expect(service.callback({ code: 'fixture', state: link.state }, link.state)).rejects.toThrow('expired');
      expect(verify).toHaveBeenCalledWith({ idToken: 'fixture-id-token', audience: 'fixture-client' });
      const login = await service.start(); identity = ticket(new URL(login.url).searchParams.get('nonce')!);
      expect(await service.callback({ code: 'fixture', state: login.state }, login.state)).toMatchObject({ mfaRequired: true });
    } finally { factory.mockRestore(); token.mockRestore(); verify.mockRestore(); env.GOOGLE_OAUTH_CLIENT_ID = oldClientId; }
  });
  it('does not delete an account while it owns a workspace', async () => {
    await request(app.getHttpServer()).post('/api/privacy/account/delete').set(headers()).send({ password, code: recoveryCodes[2], confirmation: 'DELETE MY ACCOUNT' }).expect(403);
    expect((await db.user.findUniqueOrThrow({ where: { id: userId } })).deletedAt).toBeNull();
  });
  it('deletes workspace data and access, retaining immutable accounting references', async () => {
    await db.project.create({ data: { organizationId: orgId, name: 'Privacy fixture', description: 'Research data which must be removed by workspace deletion.' } });
    await request(app.getHttpServer()).post(`/api/privacy/organizations/${orgId}/delete`).set(headers()).send({ password, code: recoveryCodes[3], confirmation: 'DELETE THIS WORKSPACE' }).expect(201);
    expect(await db.project.count({ where: { organizationId: orgId } })).toBe(0); expect(await db.membership.count({ where: { organizationId: orgId } })).toBe(0);
    expect(await db.creditLedger.count({ where: { organizationId: orgId } })).toBeGreaterThan(0);
    expect((await db.organization.findUniqueOrThrow({ where: { id: orgId } })).deletedAt).not.toBeNull();
  });
  it('removes personal account data and revokes its sessions after ownership is resolved', async () => {
    await request(app.getHttpServer()).post('/api/privacy/account/delete').set(headers()).send({ password, code: recoveryCodes[4], confirmation: 'DELETE MY ACCOUNT' }).expect(201);
    const user = await db.user.findUniqueOrThrow({ where: { id: userId } }); expect(user.deletedAt).not.toBeNull(); expect(user.email).not.toBe(email);
    await request(app.getHttpServer()).get('/api/auth/me').set('Cookie', cookie).expect(401);
    expect(await db.mFAFactor.count({ where: { userId } })).toBe(0);
  });
});
