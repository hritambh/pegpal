import { validateQuantity, type CreateOrderRequest, type LiquidPublicView, type MachinePublicView } from '@pegpal/shared';
import { linePriceMicros, microsToDecimalString } from './format';

/** liquidId -> requested mL. A NaN value means the input is currently not a number. */
export type Cart = Record<string, number>;

export interface CartLine {
  liquid: LiquidPublicView;
  volumeMl: number;
  error: string | null;
  /** Estimated line price as a 2-decimal string, or null when it can't be computed. */
  estimatedPrice: string | null;
}

export interface CartSummary {
  lines: CartLine[];
  totalMl: number;
  estimatedTotal: string;
  /** Cart-level problems (empty, too many items, too much volume, unavailable liquids). */
  errors: string[];
  canSubmit: boolean;
}

export function summarizeCart(cart: Cart, liquids: LiquidPublicView[], limits: MachinePublicView['limits']): CartSummary {
  const byId = new Map(liquids.map((l) => [l.id, l]));
  const lines: CartLine[] = [];
  const errors: string[] = [];
  let totalMl = 0;
  let totalMicros = 0;

  for (const [liquidId, volumeMl] of Object.entries(cart)) {
    const liquid = byId.get(liquidId);
    if (!liquid) {
      errors.push('An item in your selection is no longer offered. Please remove it.');
      continue;
    }
    let error = validateQuantity(volumeMl, { minMl: liquid.minMl, maxMl: liquid.maxMl });
    if (!liquid.available) error = `${liquid.name} is unavailable${liquid.unavailableReason ? `: ${liquid.unavailableReason}` : ''}`;
    const micros = error === null ? linePriceMicros(liquid.pricePerMl, volumeMl) : null;
    if (error === null) {
      totalMl += volumeMl;
      if (micros !== null) totalMicros += micros;
    }
    lines.push({ liquid, volumeMl, error, estimatedPrice: micros === null ? null : microsToDecimalString(micros) });
  }

  lines.sort((a, b) => liquids.indexOf(a.liquid) - liquids.indexOf(b.liquid));

  if (lines.length === 0 && errors.length === 0) errors.push('Choose at least one liquid.');
  if (lines.length > limits.maxItems) errors.push(`At most ${limits.maxItems} liquids per order.`);
  if (totalMl > limits.maxTotalMl) errors.push(`Total volume ${totalMl} mL exceeds the ${limits.maxTotalMl} mL limit.`);

  const lineErrors = lines.some((l) => l.error !== null);
  return {
    lines,
    totalMl,
    estimatedTotal: microsToDecimalString(totalMicros),
    errors,
    canSubmit: lines.length > 0 && errors.length === 0 && !lineErrors,
  };
}

export function toCreateOrderRequest(machineId: string, summary: CartSummary): CreateOrderRequest {
  return { machineId, items: summary.lines.map((l) => ({ liquidId: l.liquid.id, volumeMl: l.volumeMl })) };
}

/** Stable fingerprint of a request body, used to decide whether an idempotency key can be reused. */
export function requestFingerprint(req: CreateOrderRequest): string {
  return JSON.stringify({ machineId: req.machineId, items: req.items.map((i) => [i.liquidId, i.volumeMl]) });
}

export interface PendingAttempt {
  idempotencyKey: string;
  fingerprint: string;
}

/**
 * Reuses the stored key when the same body is being retried (double-tap, network retry),
 * otherwise starts a new attempt with a fresh key. Reusing a key with a different body is a 409.
 */
export function resolveAttempt(stored: PendingAttempt | null, req: CreateOrderRequest, newKey: () => string): PendingAttempt {
  const fingerprint = requestFingerprint(req);
  if (stored && stored.fingerprint === fingerprint) return stored;
  return { idempotencyKey: newKey(), fingerprint };
}

/** Clamps a stepper value into [min, max] in whole mL. */
export function stepVolume(current: number, delta: number, minMl: number, maxMl: number): number {
  const base = Number.isFinite(current) ? Math.round(current) : minMl;
  return Math.min(maxMl, Math.max(minMl, base + delta));
}

/** A reasonable default stepper increment for a liquid's range. */
export function stepSize(minMl: number, maxMl: number): number {
  const range = maxMl - minMl;
  if (range >= 100) return 10;
  if (range >= 20) return 5;
  return 1;
}
