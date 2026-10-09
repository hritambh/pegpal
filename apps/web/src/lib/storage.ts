/** sessionStorage helpers. Every access is guarded: storage can be missing or throw (private mode, SSR). */

export function sessionGet(key: string): string | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

export function sessionSet(key: string, value: string): void {
  try {
    if (typeof window !== 'undefined') window.sessionStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

export function sessionRemove(key: string): void {
  try {
    if (typeof window !== 'undefined') window.sessionStorage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}

export function sessionGetJson<T>(key: string): T | null {
  const raw = sessionGet(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function sessionSetJson(key: string, value: unknown): void {
  sessionSet(key, JSON.stringify(value));
}

export const ADMIN_TOKEN_KEY = 'pegpal_admin_token';
export const orderTokenKey = (orderId: string) => `pegpal_order_token_${orderId}`;
export const cartKey = (machineId: string) => `pegpal_cart_${machineId}`;

/** UUID v4. Falls back to getRandomValues because randomUUID needs a secure context (plain-HTTP LAN QR URLs). */
export function newIdempotencyKey(): string {
  const c: Crypto | undefined = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (c && typeof c.randomUUID === 'function') {
    try {
      return c.randomUUID();
    } catch {
      /* fall through */
    }
  }
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
