/** Pure formatting helpers. Money is handled as integer micro-units to avoid float drift. */

const MICRO_DECIMALS = 6;
const MICRO = 10 ** MICRO_DECIMALS;

/** Parses a non-negative decimal string such as "0.0500" into integer micro-units. Returns null when malformed. */
export function parseDecimalToMicros(value: string): number | null {
  const m = /^\s*(\d+)(?:\.(\d+))?\s*$/.exec(value);
  if (!m) return null;
  const whole = Number(m[1]);
  const fracRaw = (m[2] ?? '').slice(0, MICRO_DECIMALS + 1);
  let frac = Number(fracRaw.slice(0, MICRO_DECIMALS).padEnd(MICRO_DECIMALS, '0'));
  // Round half up on the 7th decimal.
  if (fracRaw.length > MICRO_DECIMALS && Number(fracRaw[MICRO_DECIMALS]) >= 5) frac += 1;
  const micros = whole * MICRO + frac;
  return Number.isSafeInteger(micros) ? micros : null;
}

/** Converts micro-units to a 2-decimal string, rounding half up. */
export function microsToDecimalString(micros: number, decimals = 2): string {
  const factor = 10 ** (MICRO_DECIMALS - decimals);
  const rounded = Math.round(micros / factor);
  const negative = rounded < 0;
  const abs = Math.abs(rounded);
  const whole = Math.floor(abs / 10 ** decimals);
  const frac = String(abs % 10 ** decimals).padStart(decimals, '0');
  return `${negative ? '-' : ''}${whole}${decimals > 0 ? `.${frac}` : ''}`;
}

/** Price per mL (decimal string) × integer mL, in micro-units. Null if the price can't be parsed. */
export function linePriceMicros(pricePerMl: string, volumeMl: number): number | null {
  const unit = parseDecimalToMicros(pricePerMl);
  if (unit === null || !Number.isFinite(volumeMl)) return null;
  return unit * volumeMl;
}

/** Formats a decimal amount string with a currency code, falling back to "1.50 EUR". */
export function formatMoney(amount: string, currency: string): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return `${amount} ${currency}`;
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency}`;
  }
}

/** Unit prices are small, so keep up to 4 decimals. */
export function formatUnitPrice(pricePerMl: string, currency: string): string {
  const n = Number(pricePerMl);
  if (!Number.isFinite(n)) return `${pricePerMl} ${currency}/mL`;
  try {
    return `${new Intl.NumberFormat('en', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(n)}/mL`;
  } catch {
    return `${pricePerMl} ${currency}/mL`;
  }
}

export function formatMl(ml: number | null | undefined, decimals = 0): string {
  if (ml === null || ml === undefined || !Number.isFinite(ml)) return '—';
  return `${decimals > 0 ? ml.toFixed(decimals) : Math.round(ml)} mL`;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}

export function formatNumber(n: number | null | undefined, decimals = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return n.toFixed(decimals);
}

export function shortId(id: string | null | undefined): string {
  if (!id) return '—';
  return id.length > 8 ? id.slice(0, 8) : id;
}
