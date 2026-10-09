'use client';

import { useState } from 'react';
import type { OrderView } from '@pegpal/shared';
import { formatMoney, formatMl } from '@/lib/format';
import { Button, Card, ErrorBox } from '../ui';
import { PaymentModeBanner } from './PaymentModeBanner';

interface Props {
  order: OrderView;
  busy: boolean;
  error: string | null;
  onConfirm: (testPaymentConfirmed: boolean) => void;
  onChangeSelection: () => void;
  onCancel: () => void;
}

export function ReviewStep({ order, busy, error, onConfirm, onChangeSelection, onCancel }: Props) {
  const [simulated, setSimulated] = useState(false);
  const isTest = order.payment.mode === 'TEST_MODE';
  const expires = order.expiresAt ? new Date(order.expiresAt) : null;

  return (
    <div className="flex flex-col gap-4">
      <PaymentModeBanner mode={order.payment.mode} />
      <Card>
        <h2 className="text-lg font-bold">Review your order</h2>
        <p className="text-sm text-slate-500">
          Machine {order.machineName} · Order {order.id}
        </p>
        <ul className="mt-3 divide-y divide-slate-100">
          {order.items.map((i) => (
            <li key={i.id} className="flex items-center justify-between gap-2 py-2">
              <span className="min-w-0 truncate">{i.liquidName}</span>
              <span className="shrink-0 text-right tabular-nums">
                {formatMl(i.requestedMl)} · {formatMoney(i.linePrice, order.currency)}
              </span>
            </li>
          ))}
        </ul>
        <dl className="mt-3 grid grid-cols-2 gap-y-1">
          <dt className="text-slate-600">Total volume</dt>
          <dd className="text-right tabular-nums">{formatMl(order.totalVolumeMl)}</dd>
          <dt className="text-lg font-bold">Total price</dt>
          <dd className="text-right text-lg font-bold tabular-nums">{formatMoney(order.totalPrice, order.currency)}</dd>
        </dl>
        <p className="mt-1 text-xs text-slate-500">Price calculated by the machine.</p>
        {expires && !Number.isNaN(expires.getTime()) && (
          <p className="mt-2 text-sm text-slate-600">Please confirm before {expires.toLocaleTimeString()} or the machine is released.</p>
        )}
      </Card>

      {isTest && (
        <label className="flex min-h-14 cursor-pointer items-center gap-3 rounded-2xl border-2 border-dashed border-amber-400 bg-amber-50 px-4 py-3">
          <input type="checkbox" className="h-6 w-6 accent-amber-600" checked={simulated} onChange={(e) => setSimulated(e.target.checked)} />
          <span className="font-semibold text-amber-900">Simulate payment (test) — no money is taken</span>
        </label>
      )}

      <ErrorBox error={error} />

      <Button size="lg" disabled={busy || (isTest && !simulated)} onClick={() => onConfirm(isTest && simulated)}>
        {busy ? 'Please wait…' : 'Start dispensing'}
      </Button>
      <div className="grid grid-cols-2 gap-2">
        <Button variant="secondary" disabled={busy} onClick={onChangeSelection}>
          Change selection
        </Button>
        <Button variant="danger" disabled={busy} onClick={onCancel}>
          Cancel order
        </Button>
      </div>
    </div>
  );
}
