import type { MachinePublicView } from '@pegpal/shared';
import type { CartSummary } from '@/lib/cart';
import { formatMoney } from '@/lib/format';
import { Card } from '../ui';

interface Props {
  summary: CartSummary;
  machine: MachinePublicView;
  onRemove: (liquidId: string) => void;
}

export function CartSummaryCard({ summary, machine, onRemove }: Props) {
  const over = summary.totalMl > machine.limits.maxTotalMl;
  return (
    <Card>
      <h2 className="mb-2 text-lg font-bold">Your selection</h2>
      {summary.lines.length === 0 ? (
        <p className="text-slate-500">Nothing selected yet.</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {summary.lines.map((l) => (
            <li key={l.liquid.id} className="flex items-center gap-2 py-2">
              <span className="min-w-0 flex-1 truncate">{l.liquid.name}</span>
              <span className="shrink-0 tabular-nums">{Number.isFinite(l.volumeMl) ? `${l.volumeMl} mL` : '—'}</span>
              <button type="button" className="min-h-11 shrink-0 px-2 text-sm font-semibold text-red-700" onClick={() => onRemove(l.liquid.id)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <dl className="mt-3 grid grid-cols-2 gap-y-1 text-sm">
        <dt className="text-slate-600">Items</dt>
        <dd className="text-right tabular-nums">
          {summary.lines.length} / {machine.limits.maxItems}
        </dd>
        <dt className="text-slate-600">Total volume</dt>
        <dd className={`text-right tabular-nums ${over ? 'font-bold text-red-700' : ''}`}>
          {summary.totalMl} / {machine.limits.maxTotalMl} mL
        </dd>
        <dt className="font-semibold">Estimated total</dt>
        <dd className="text-right font-semibold tabular-nums">{formatMoney(summary.estimatedTotal, machine.currency)}</dd>
      </dl>
      <p className="mt-2 text-xs text-slate-500">Prices are estimated — final price calculated by the machine.</p>
      {summary.errors.length > 0 && summary.lines.length > 0 && (
        <ul className="mt-2 list-disc pl-5 text-sm font-medium text-red-700">
          {summary.errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
    </Card>
  );
}
