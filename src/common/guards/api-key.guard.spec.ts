import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiKeyGuard } from './api-key.guard';

function context(method: string, headers: Record<string, unknown> = {}): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ method, headers }) }),
  } as unknown as ExecutionContext;
}

function guardWithKey(key: string): ApiKeyGuard {
  const config = { get: () => key } as unknown as ConfigService;
  return new ApiKeyGuard(config);
}

describe('ApiKeyGuard', () => {
  it('lets read methods through without a key', () => {
    const guard = guardWithKey('secret');
    expect(guard.canActivate(context('GET'))).toBe(true);
    expect(guard.canActivate(context('HEAD'))).toBe(true);
    expect(guard.canActivate(context('OPTIONS'))).toBe(true);
  });

  it('blocks a mutation with no / wrong key when configured', () => {
    const guard = guardWithKey('secret');
    expect(() => guard.canActivate(context('POST'))).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(context('POST', { 'x-api-key': 'nope' }))).toThrow(
      UnauthorizedException,
    );
  });

  it('allows a mutation with the correct key', () => {
    const guard = guardWithKey('secret');
    expect(guard.canActivate(context('POST', { 'x-api-key': 'secret' }))).toBe(true);
    expect(guard.canActivate(context('DELETE', { 'x-api-key': 'secret' }))).toBe(true);
  });

  it('leaves writes open (with a warning) when no key is configured', () => {
    const guard = guardWithKey('');
    expect(guard.canActivate(context('POST'))).toBe(true);
  });
});
