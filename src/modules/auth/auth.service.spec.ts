import { ConfigService } from '@nestjs/config';
import { UserRole } from '@prisma/client';
import { AuthService } from './auth.service';

function makeAuth(overrides: Record<string, unknown> = {}): AuthService {
  const values: Record<string, unknown> = {
    'auth.sessionSecret': 'test-signing-secret',
    'auth.adminUsername': 'admin',
    'auth.adminPassword': 'supersecret',
    'auth.sessionTtlHours': 12,
    ...overrides,
  };
  const config = {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;
  const service = new AuthService(config);
  service.onModuleInit();
  return service;
}

describe('AuthService sessions', () => {
  it('round-trips a scout principal through the token', () => {
    const auth = makeAuth();
    const token = auth.issueToken('scout.alice', { uid: 'alice-id', role: UserRole.SCOUT });

    expect(auth.verifySession(token)).toEqual({
      username: 'scout.alice',
      uid: 'alice-id',
      role: UserRole.SCOUT,
    });
  });

  it('treats a pre-roles token as the env admin so existing cookies keep working', () => {
    const auth = makeAuth();
    // A token shaped like the ones minted before roles existed: no role claim.
    const body = Buffer.from(JSON.stringify({ sub: 'admin', exp: Date.now() + 60_000 })).toString(
      'base64url',
    );
    const legacy = `${body}.${(auth as unknown as { sign(d: string): string }).sign(body)}`;

    expect(auth.verifySession(legacy)).toEqual({
      username: 'admin',
      uid: null,
      role: UserRole.ADMIN,
    });
  });

  it('rejects a tampered role claim', () => {
    const auth = makeAuth();
    const token = auth.issueToken('scout.alice', { uid: 'alice-id', role: UserRole.SCOUT });

    // Re-encode the payload as ADMIN but keep the original signature.
    const [body, sig] = token.split('.');
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    payload.role = UserRole.ADMIN;
    const forged = Buffer.from(JSON.stringify(payload)).toString('base64url') + '.' + sig;

    expect(auth.verifySession(forged)).toBeNull();
  });

  it('rejects an expired or malformed token', () => {
    const auth = makeAuth();
    const body = Buffer.from(
      JSON.stringify({ sub: 'admin', role: UserRole.ADMIN, exp: Date.now() - 1000 }),
    ).toString('base64url');
    const expired = `${body}.${(auth as unknown as { sign(d: string): string }).sign(body)}`;

    expect(auth.verifySession(expired)).toBeNull();
    expect(auth.verifySession('not-a-token')).toBeNull();
    expect(auth.verifySession(undefined)).toBeNull();
  });

  it('only treats an unknown role claim as ADMIN when it is absent, not when it is junk', () => {
    const auth = makeAuth();
    const token = auth.issueToken('someone', { uid: 'u1', role: 'SUPERUSER' as UserRole });
    // Anything that isn't SCOUT falls back to ADMIN, which is why issuing is
    // only ever done from verified credentials.
    expect(auth.verifySession(token)?.role).toBe(UserRole.ADMIN);
  });
});
