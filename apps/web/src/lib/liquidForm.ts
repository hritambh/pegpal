import { PUMP_CHANNEL_COUNT, type AdminLiquidView, type DispenseStrategy, type UpsertLiquidRequest } from '@pegpal/shared';

export interface LiquidFormValues {
  name: string;
  imageUrl: string;
  pumpChannel: string;
  strategy: DispenseStrategy;
  densityGPerMl: string;
  cutoffMarginG: string;
  minMl: string;
  maxMl: string;
  pricePerMl: string;
  active: boolean;
  remainingStockMl: string;
}

export const EMPTY_LIQUID_FORM: LiquidFormValues = {
  name: '',
  imageUrl: '',
  pumpChannel: '0',
  strategy: 'TIMED',
  densityGPerMl: '',
  cutoffMarginG: '',
  minMl: '10',
  maxMl: '100',
  pricePerMl: '0.0500',
  active: true,
  remainingStockMl: '',
};

export function liquidToForm(l: AdminLiquidView): LiquidFormValues {
  const s = (v: number | null) => (v === null ? '' : String(v));
  return {
    name: l.name,
    imageUrl: l.imageUrl ?? '',
    pumpChannel: String(l.pumpChannel),
    strategy: l.strategy,
    densityGPerMl: s(l.densityGPerMl),
    cutoffMarginG: String(l.cutoffMarginG),
    minMl: String(l.minMl),
    maxMl: String(l.maxMl),
    pricePerMl: l.pricePerMl,
    active: l.active,
    remainingStockMl: s(l.remainingStockMl),
  };
}

const isInt = (s: string) => /^\d+$/.test(s.trim());

/** Validates the form and builds the request body. Returns either the body or a list of errors. */
export function parseLiquidForm(v: LiquidFormValues): { ok: true; body: UpsertLiquidRequest } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const name = v.name.trim();
  if (!name) errors.push('Name is required');
  if (!isInt(v.pumpChannel) || Number(v.pumpChannel) >= PUMP_CHANNEL_COUNT) errors.push(`Pump channel must be 0-${PUMP_CHANNEL_COUNT - 1}`);
  if (!isInt(v.minMl) || Number(v.minMl) <= 0) errors.push('Min mL must be a positive whole number');
  if (!isInt(v.maxMl) || Number(v.maxMl) <= 0) errors.push('Max mL must be a positive whole number');
  if (isInt(v.minMl) && isInt(v.maxMl) && Number(v.minMl) > Number(v.maxMl)) errors.push('Min mL must not exceed max mL');
  if (!/^\d+(\.\d{1,6})?$/.test(v.pricePerMl.trim())) errors.push('Price per mL must be a decimal like 0.0500');

  let density: number | null = null;
  if (v.densityGPerMl.trim() !== '') {
    density = Number(v.densityGPerMl);
    if (!Number.isFinite(density) || density <= 0) errors.push('Density must be a positive number');
  }
  if (v.strategy === 'WEIGHT' && density === null) errors.push('WEIGHT strategy needs a density');

  let cutoff: number | undefined;
  if (v.cutoffMarginG.trim() !== '') {
    cutoff = Number(v.cutoffMarginG);
    if (!Number.isFinite(cutoff) || cutoff < 0) errors.push('Cutoff margin must be >= 0');
  }

  let stock: number | null = null;
  if (v.remainingStockMl.trim() !== '') {
    if (!isInt(v.remainingStockMl)) errors.push('Stock must be a whole number of mL');
    else stock = Number(v.remainingStockMl);
  }

  const imageUrl = v.imageUrl.trim();
  if (imageUrl && !/^(https?:\/\/|\/)/.test(imageUrl)) errors.push('Image URL must start with http(s):// or /');

  if (errors.length) return { ok: false, errors };
  const body: UpsertLiquidRequest = {
    name,
    imageUrl: imageUrl || null,
    pumpChannel: Number(v.pumpChannel),
    strategy: v.strategy,
    densityGPerMl: density,
    minMl: Number(v.minMl),
    maxMl: Number(v.maxMl),
    pricePerMl: v.pricePerMl.trim(),
    active: v.active,
    remainingStockMl: stock,
  };
  if (cutoff !== undefined) body.cutoffMarginG = cutoff;
  return { ok: true, body };
}
