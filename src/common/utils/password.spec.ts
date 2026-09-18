import { hashPassword, verifyPassword } from './password';

describe('password hashing', () => {
  it('produces a self-describing scrypt hash that verifies', () => {
    const stored = hashPassword('correct horse battery');
    expect(stored.startsWith('scrypt$')).toBe(true);
    expect(stored.split('$')).toHaveLength(6);
    expect(verifyPassword('correct horse battery', stored)).toBe(true);
  });

  it('rejects the wrong password', () => {
    const stored = hashPassword('correct horse battery');
    expect(verifyPassword('wrong horse battery', stored)).toBe(false);
    expect(verifyPassword('', stored)).toBe(false);
  });

  it('salts every hash so identical passwords differ on disk', () => {
    expect(hashPassword('same-password')).not.toBe(hashPassword('same-password'));
  });

  it('never stores the plaintext', () => {
    expect(hashPassword('hunter2')).not.toContain('hunter2');
  });

  it('returns false rather than throwing on a malformed hash', () => {
    for (const bad of ['', 'garbage', 'scrypt$only$three', 'bcrypt$1$2$3$4$5', 'scrypt$x$y$z$$']) {
      expect(verifyPassword('anything', bad)).toBe(false);
    }
  });

  it('rejects an empty password at hash time', () => {
    expect(() => hashPassword('')).toThrow();
  });
});
