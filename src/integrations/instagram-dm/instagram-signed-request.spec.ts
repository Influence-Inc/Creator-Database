import { createHmac } from 'node:crypto';
import { parseSignedRequest } from './instagram-signed-request';

const SECRET = 'app-secret-abc';

function sign(payload: object, secret = SECRET): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${sig}.${encoded}`;
}

describe('parseSignedRequest', () => {
  it('decodes a correctly signed request', () => {
    const out = parseSignedRequest(sign({ user_id: 'IGSID_9', algorithm: 'HMAC-SHA256' }), SECRET);
    expect(out?.user_id).toBe('IGSID_9');
  });

  it('rejects a request signed with the wrong secret', () => {
    expect(parseSignedRequest(sign({ user_id: 'IGSID_9' }, 'other-secret'), SECRET)).toBeNull();
  });

  it('rejects a tampered payload that keeps the original signature', () => {
    const original = sign({ user_id: 'IGSID_9' });
    const [sig] = original.split('.');
    const forged = Buffer.from(JSON.stringify({ user_id: 'IGSID_VICTIM' })).toString('base64url');
    expect(parseSignedRequest(`${sig}.${forged}`, SECRET)).toBeNull();
  });

  it('rejects malformed input rather than throwing', () => {
    for (const bad of ['', 'nodot', '.', 'a.b', null, undefined]) {
      expect(parseSignedRequest(bad as never, SECRET)).toBeNull();
    }
  });

  it('rejects everything when no app secret is configured', () => {
    expect(parseSignedRequest(sign({ user_id: 'x' }), '')).toBeNull();
  });
});
