import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Bearer token for confirm/cancel, derived from the order id so an
 * idempotent replay of POST /orders can return it again without storing it.
 */
export function orderToken(secret: string, orderId: string): string {
  return createHmac('sha256', secret).update(`order:${orderId}`).digest('base64url');
}

export function verifyOrderToken(secret: string, orderId: string, token: unknown): boolean {
  if (typeof token !== 'string' || token.length === 0 || token.length > 128) return false;
  const expected = Buffer.from(orderToken(secret, orderId));
  const actual = Buffer.from(token);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
