/**
 * Meta signs its deauthorize and data-deletion callbacks with a `signed_request`
 * rather than the `X-Hub-Signature-256` header used for webhooks.
 *
 * The format is `<base64url signature>.<base64url json payload>`, where the
 * signature is an HMAC-SHA256 of the *encoded payload string* keyed with the
 * app secret. Verifying it is what stops anyone POSTing a user id and wiping
 * that person's records.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SignedRequestPayload {
  /** The Instagram-scoped id of the person the callback is about. */
  user_id?: string;
  algorithm?: string;
  issued_at?: number;
  [key: string]: unknown;
}

/**
 * Verify and decode a signed_request. Returns null for anything malformed or
 * incorrectly signed — callers treat that as "reject", never as "empty".
 */
export function parseSignedRequest(
  signedRequest: string | undefined | null,
  appSecret: string,
): SignedRequestPayload | null {
  if (!signedRequest || typeof signedRequest !== 'string' || !appSecret) return null;

  const dot = signedRequest.indexOf('.');
  if (dot <= 0) return null;

  const encodedSig = signedRequest.slice(0, dot);
  const encodedPayload = signedRequest.slice(dot + 1);

  let expected: Buffer;
  let provided: Buffer;
  try {
    provided = Buffer.from(encodedSig, 'base64url');
    // Signed over the encoded payload exactly as received.
    expected = createHmac('sha256', appSecret).update(encodedPayload).digest();
  } catch {
    return null;
  }

  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;

  try {
    const json = Buffer.from(encodedPayload, 'base64url').toString('utf8');
    const payload = JSON.parse(json) as SignedRequestPayload;
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}
