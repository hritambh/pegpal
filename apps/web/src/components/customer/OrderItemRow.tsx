import type { OrderItemView } from '@pegpal/shared';
import { formatMl } from '@/lib/format';
import { ITEM_STATUS_LABEL, verificationLabel } from '@/lib/labels';
import { itemProgressPercent } from '@/lib/progress';
import { Badge, ProgressBar } from '../ui';

export function OrderItemRow({ item }: { item: OrderItemView }) {
  const s = ITEM_STATUS_LABEL[item.status];
  const showBar = item.status === 'DISPENSING';
  const finished = item.status !== 'PENDING' && item.status !== 'DISPENSING';
  return (
    <li className="flex flex-col gap-1 py-3">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate font-medium">{item.liquidName}</span>
        <Badge tone={s.tone}>{s.label}</Badge>
      </div>
      <p className="text-sm text-slate-600">
        Target {formatMl(item.requestedMl)}
        {item.status === 'DISPENSING' && item.progressMl !== null && ` · about ${formatMl(item.progressMl)} so far`}
        {finished && item.deliveredMl !== null && ` · delivered ${formatMl(item.deliveredMl, 1)}`}
      </p>
      {showBar && <ProgressBar percent={itemProgressPercent(item)} label={`${item.liquidName} progress`} />}
      {finished && (
        <p className="text-xs text-slate-500">
          {verificationLabel(item.verification)}
          {item.verificationNote ? ` — ${item.verificationNote}` : ''}
        </p>
      )}
    </li>
  );
}
