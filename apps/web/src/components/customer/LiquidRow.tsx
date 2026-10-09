'use client';

import type { LiquidPublicView } from '@pegpal/shared';
import { stepSize, stepVolume } from '@/lib/cart';
import { formatMoney, formatUnitPrice } from '@/lib/format';

interface Props {
  liquid: LiquidPublicView;
  currency: string;
  /** Undefined when not selected. NaN when the input isn't a number. */
  volumeMl: number | undefined;
  error: string | null;
  estimatedPrice: string | null;
  onToggle: (selected: boolean) => void;
  onChange: (volumeMl: number) => void;
}

export function LiquidRow({ liquid, currency, volumeMl, error, estimatedPrice, onToggle, onChange }: Props) {
  const selected = volumeMl !== undefined;
  const step = stepSize(liquid.minMl, liquid.maxMl);
  const inputId = `qty-${liquid.id}`;

  return (
    <li
      className={`rounded-2xl p-3 ring-1 ${
        !liquid.available ? 'bg-slate-100 opacity-60 ring-slate-200' : selected ? 'bg-blue-50 ring-2 ring-blue-500' : 'bg-white ring-slate-200'
      }`}
    >
      <label className="flex min-h-12 cursor-pointer items-center gap-3">
        <input
          type="checkbox"
          className="h-6 w-6 shrink-0 accent-blue-600"
          checked={selected}
          disabled={!liquid.available && !selected}
          onChange={(e) => onToggle(e.target.checked)}
        />
        {liquid.imageUrl && (
          // eslint-disable-next-line @next/next/no-img-element -- arbitrary operator-supplied URLs
          <img src={liquid.imageUrl} alt="" className="h-12 w-12 shrink-0 rounded-lg object-cover" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate font-semibold">{liquid.name}</span>
          <span className="block text-sm text-slate-600">
            {formatUnitPrice(liquid.pricePerMl, currency)} · {liquid.minMl}–{liquid.maxMl} mL
          </span>
          {!liquid.available && <span className="block text-sm font-medium text-slate-700">Unavailable{liquid.unavailableReason ? `: ${liquid.unavailableReason}` : ''}</span>}
        </span>
      </label>

      {selected && (
        <div className="mt-3 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label={`Decrease ${liquid.name}`}
              className="h-12 w-12 shrink-0 rounded-xl bg-white text-2xl font-bold ring-1 ring-slate-300 disabled:opacity-40"
              onClick={() => onChange(stepVolume(volumeMl, -step, liquid.minMl, liquid.maxMl))}
              disabled={Number.isFinite(volumeMl) && volumeMl <= liquid.minMl}
            >
              −
            </button>
            <label htmlFor={inputId} className="sr-only">
              {liquid.name} quantity in mL
            </label>
            <input
              id={inputId}
              type="number"
              inputMode="numeric"
              min={liquid.minMl}
              max={liquid.maxMl}
              step={1}
              value={Number.isFinite(volumeMl) ? volumeMl : ''}
              onChange={(e) => onChange(e.target.value === '' ? NaN : Number(e.target.value))}
              aria-invalid={error !== null}
              className="h-12 w-full min-w-0 rounded-xl border border-slate-300 px-3 text-center text-lg font-semibold"
            />
            <span className="shrink-0 text-slate-600">mL</span>
            <button
              type="button"
              aria-label={`Increase ${liquid.name}`}
              className="h-12 w-12 shrink-0 rounded-xl bg-white text-2xl font-bold ring-1 ring-slate-300 disabled:opacity-40"
              onClick={() => onChange(stepVolume(volumeMl, step, liquid.minMl, liquid.maxMl))}
              disabled={Number.isFinite(volumeMl) && volumeMl >= liquid.maxMl}
            >
              +
            </button>
          </div>
          {error ? (
            <p className="text-sm font-medium text-red-700">{error}</p>
          ) : (
            estimatedPrice && <p className="text-sm text-slate-600">Estimated {formatMoney(estimatedPrice, currency)}</p>
          )}
        </div>
      )}
    </li>
  );
}
