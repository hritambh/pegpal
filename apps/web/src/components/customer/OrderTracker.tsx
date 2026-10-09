'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { isTerminalStatus, type MachinePublicView } from '@pegpal/shared';
import { useOrderStream } from '@/hooks/useOrderStream';
import { customerApi, errorMessage } from '@/lib/api';
import { formatMl, formatMoney } from '@/lib/format';
import { AVAILABILITY_LABEL, ORDER_STATUS_LABEL, finalMessage } from '@/lib/labels';
import { groupItems, itemProgressPercent, orderProgressPercent } from '@/lib/progress';
import { orderTokenKey, sessionGet } from '@/lib/storage';
import { Badge, Banner, Button, Card, ErrorBox, ProgressBar, Spinner } from '../ui';
import { OrderItemRow } from './OrderItemRow';

export function OrderTracker({ orderId }: { orderId: string }) {
  const { order, error, notFound, mode, refresh, setOrder } = useOrderStream(orderId);
  const [machine, setMachine] = useState<MachinePublicView | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [hasToken, setHasToken] = useState(false);

  useEffect(() => {
    setHasToken(Boolean(sessionGet(orderTokenKey(orderId))));
  }, [orderId]);

  const machineId = order?.machineId;
  const status = order?.status;
  useEffect(() => {
    if (!machineId) return;
    let cancelled = false;
    customerApi
      .getMachine(machineId)
      .then((m) => !cancelled && setMachine(m))
      .catch(() => !cancelled && setMachine(null));
    return () => {
      cancelled = true;
    };
  }, [machineId, status]);

  if (notFound) {
    return (
      <Card className="text-center">
        <h1 className="text-2xl font-bold">Order not found</h1>
        <p className="mt-2 text-slate-600">Please check the link or ask staff for help.</p>
      </Card>
    );
  }
  if (!order) {
    return error ? (
      <Card className="flex flex-col gap-3">
        <ErrorBox error={error} />
        <Button onClick={() => void refresh()}>Try again</Button>
      </Card>
    ) : (
      <Spinner label="Loading your order…" />
    );
  }

  const terminal = isTerminalStatus(order.status);
  const statusLabel = ORDER_STATUS_LABEL[order.status];
  const groups = groupItems(order.items);
  const final = finalMessage(order.status);

  const cancel = async () => {
    const token = sessionGet(orderTokenKey(order.id));
    if (!token || cancelBusy) return;
    setCancelBusy(true);
    setCancelError(null);
    try {
      const res = await customerApi.cancelOrder(order.id, token);
      if (res.data && typeof res.data === 'object' && 'status' in res.data) setOrder(res.data);
      else await refresh();
    } catch (err) {
      setCancelError(errorMessage(err));
    } finally {
      setCancelBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold">Your order</h1>
          <p className="break-all text-xs text-slate-500">Order {order.id}</p>
        </div>
        <Badge tone={order.cancelRequested && !terminal ? 'amber' : statusLabel.tone} large>
          {order.cancelRequested && !terminal ? 'Stopping…' : statusLabel.label}
        </Badge>
      </header>

      {order.payment.isTest && <Banner tone="amber" title="TEST MODE — no real payment was taken" />}
      {order.payment.mode === 'PAYMENT_DISABLED' && <Banner tone="blue" title="Internal testing — payment disabled" />}

      {final && (
        <Banner tone={final.tone} title={final.title}>
          <p>{final.body}</p>
          {order.failureReason && (order.status === 'FAILED' || order.status === 'SAFETY_STOPPED' || order.status === 'CANCELLED') && (
            <p className="mt-1">Reason: {order.failureReason}</p>
          )}
        </Banner>
      )}

      {!terminal && (
        <Card>
          {groups.current ? (
            <>
              <p className="text-sm text-slate-600">Now pouring</p>
              <p className="text-xl font-bold">{groups.current.liquidName}</p>
              <p className="mb-2 text-sm text-slate-600">
                Target {formatMl(groups.current.requestedMl)} · {Math.round(itemProgressPercent(groups.current))}%
              </p>
              <ProgressBar percent={itemProgressPercent(groups.current)} label="Current ingredient progress" />
            </>
          ) : (
            <p className="font-medium">
              {order.status === 'CREATED' ? 'Waiting for confirmation…' : order.cancelRequested ? 'Stopping the pumps…' : 'Preparing the machine…'}
            </p>
          )}
          <p className="mt-4 text-sm text-slate-600">Overall</p>
          <ProgressBar percent={orderProgressPercent(order)} label="Overall progress" />
        </Card>
      )}

      <Card>
        <h2 className="text-lg font-bold">Ingredients</h2>
        <p className="text-sm text-slate-600">
          {groups.completed.length} done · {groups.remaining.length} remaining · {formatMl(order.totalVolumeMl)} total ·{' '}
          {formatMoney(order.totalPrice, order.currency)}
        </p>
        <ul className="divide-y divide-slate-100">
          {[...order.items]
            .sort((a, b) => a.position - b.position)
            .map((i) => (
              <OrderItemRow key={i.id} item={i} />
            ))}
        </ul>
      </Card>

      <Card className="flex items-center justify-between gap-2 text-sm">
        <span className="text-slate-600">Machine {machine?.name ?? order.machineName}</span>
        {machine ? <Badge tone={AVAILABILITY_LABEL[machine.availability].tone}>{AVAILABILITY_LABEL[machine.availability].label}</Badge> : <span>—</span>}
      </Card>

      {mode === 'polling' && !terminal && <p className="text-center text-xs text-slate-500">Live updates unavailable — refreshing every 2 seconds.</p>}
      {error && <ErrorBox error={error} />}
      <ErrorBox error={cancelError} />

      {!terminal &&
        (hasToken ? (
          <Button variant="danger" size="lg" disabled={cancelBusy || order.cancelRequested} onClick={() => void cancel()}>
            {order.cancelRequested ? 'Stopping…' : cancelBusy ? 'Cancelling…' : 'Cancel order'}
          </Button>
        ) : (
          <p className="text-center text-sm text-slate-500">This order can only be cancelled from the phone that placed it, or by staff.</p>
        ))}

      {terminal && (
        <Link href={`/machine/${encodeURIComponent(order.machineId)}`} className="text-center font-semibold text-blue-700 underline">
          Start a new order
        </Link>
      )}
    </div>
  );
}
