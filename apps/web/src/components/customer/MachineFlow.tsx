'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ACTIVE_ORDER_STATUSES, type LiquidPublicView, type MachinePublicView, type OrderView } from '@pegpal/shared';
import { ApiRequestError, customerApi, errorMessage } from '@/lib/api';
import { resolveAttempt, summarizeCart, toCreateOrderRequest, type Cart, type PendingAttempt } from '@/lib/cart';
import { formatMoney } from '@/lib/format';
import { cartKey, newIdempotencyKey, orderTokenKey, sessionGet, sessionGetJson, sessionSet, sessionSetJson } from '@/lib/storage';
import { Banner, Button, Card, ErrorBox, Spinner } from '../ui';
import { CartSummaryCard } from './CartSummaryCard';
import { LiquidRow } from './LiquidRow';
import { MachineHeader } from './MachineHeader';
import { PaymentModeBanner } from './PaymentModeBanner';
import { ReviewStep } from './ReviewStep';

type Step = 'overview' | 'select' | 'review';

interface Persisted {
  cart: Record<string, number | null>;
  attempt: PendingAttempt | null;
  orderId: string | null;
}

/** Errors where the server may or may not have created the order: keep the key so a retry is deduplicated. */
function outcomeUnknown(err: unknown): boolean {
  return !(err instanceof ApiRequestError) || err.status === 0 || err.status === 429 || err.status >= 500;
}

export function MachineFlow({ machineId }: { machineId: string }) {
  const router = useRouter();
  const [machine, setMachine] = useState<MachinePublicView | null>(null);
  const [liquids, setLiquids] = useState<LiquidPublicView[]>([]);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'notfound' | 'error'>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>('overview');
  const [cart, setCart] = useState<Cart>({});
  const [attempt, setAttempt] = useState<PendingAttempt | null>(null);
  const [order, setOrder] = useState<OrderView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const hydrated = useRef(false);

  const persist = useCallback(
    (next: Partial<Persisted>) => {
      const cur = sessionGetJson<Persisted>(cartKey(machineId)) ?? { cart: {}, attempt: null, orderId: null };
      sessionSetJson(cartKey(machineId), { ...cur, ...next });
    },
    [machineId],
  );

  const loadMachine = useCallback(async () => {
    setLoadError(null);
    try {
      const [m, l] = await Promise.all([customerApi.getMachine(machineId), customerApi.getLiquids(machineId)]);
      setMachine(m);
      setLiquids(l);
      setLoadState('ready');
      return m;
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 404) setLoadState('notfound');
      else {
        setLoadError(errorMessage(err));
        setLoadState((s) => (s === 'ready' ? s : 'error'));
      }
      return null;
    }
  }, [machineId]);

  // Initial load + restore the session's cart / pending order.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stored = sessionGetJson<Persisted>(cartKey(machineId));
      if (stored && !hydrated.current) {
        const restored: Cart = {};
        for (const [k, v] of Object.entries(stored.cart ?? {})) restored[k] = typeof v === 'number' ? v : NaN;
        setCart(restored);
        setAttempt(stored.attempt ?? null);
      }
      hydrated.current = true;
      await loadMachine();
      if (cancelled || !stored?.orderId) return;
      try {
        const o = await customerApi.getOrder(stored.orderId);
        if (cancelled) return;
        if (o.status === 'CREATED' && sessionGet(orderTokenKey(o.id))) {
          setOrder(o);
          setStep('review');
        } else if (ACTIVE_ORDER_STATUSES.includes(o.status) && o.status !== 'CREATED') {
          router.replace(`/order/${encodeURIComponent(o.id)}`);
        } else {
          persist({ orderId: null, attempt: null });
          setAttempt(null);
        }
      } catch {
        persist({ orderId: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [machineId, loadMachine, persist, router]);

  const summary = useMemo(
    () => (machine ? summarizeCart(cart, liquids, machine.limits) : null),
    [cart, liquids, machine],
  );

  const updateCart = (next: Cart) => {
    setCart(next);
    setError(null);
    persist({ cart: next });
  };

  const toggle = (l: LiquidPublicView, selected: boolean) => {
    const next = { ...cart };
    if (selected) next[l.id] = l.minMl;
    else delete next[l.id];
    updateCart(next);
  };

  const proceedToReview = async () => {
    if (!machine || !summary?.canSubmit || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const req = toCreateOrderRequest(machine.id, summary);
    const att = resolveAttempt(attempt, req, newIdempotencyKey);
    setAttempt(att);
    persist({ attempt: att });
    try {
      const res = await customerApi.createOrder(req, att.idempotencyKey);
      sessionSet(orderTokenKey(res.order.id), res.orderToken);
      persist({ orderId: res.order.id });
      setOrder(res.order);
      setStep('review');
    } catch (err) {
      if (!outcomeUnknown(err)) {
        setAttempt(null);
        persist({ attempt: null });
      }
      if (err instanceof ApiRequestError && (err.status === 409 || err.status === 422)) void loadMachine();
      setError(err instanceof ApiRequestError && err.status === 0 ? `${err.detailText} Your retry won't create a duplicate order.` : errorMessage(err));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const cancelPending = async (): Promise<boolean> => {
    if (!order) return true;
    const token = sessionGet(orderTokenKey(order.id));
    if (!token) {
      setError('This order can only be cancelled from the device that created it.');
      return false;
    }
    try {
      await customerApi.cancelOrder(order.id, token);
    } catch (err) {
      setError(errorMessage(err));
      return false;
    }
    setOrder(null);
    setAttempt(null);
    persist({ orderId: null, attempt: null });
    return true;
  };

  const runBusy = async (fn: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await fn();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const confirm = (testPaymentConfirmed: boolean) =>
    runBusy(async () => {
      if (!order) return;
      const token = sessionGet(orderTokenKey(order.id));
      if (!token) {
        setError('Order token missing on this device. Please start a new order.');
        return;
      }
      try {
        const body = order.payment.mode === 'TEST_MODE' ? { testPaymentConfirmed } : {};
        const confirmed = await customerApi.confirmOrder(order.id, token, body);
        persist({ cart: {}, attempt: null, orderId: null });
        router.push(`/order/${encodeURIComponent(confirmed.id)}`);
      } catch (err) {
        setError(errorMessage(err));
        try {
          const fresh = await customerApi.getOrder(order.id);
          if (fresh.status !== 'CREATED') {
            if (ACTIVE_ORDER_STATUSES.includes(fresh.status)) router.push(`/order/${encodeURIComponent(fresh.id)}`);
            else {
              setOrder(null);
              setAttempt(null);
              persist({ orderId: null, attempt: null });
              setStep('select');
              setError(`${errorMessage(err)} — this order is no longer pending. Please review your selection and try again.`);
              void loadMachine();
            }
          }
        } catch {
          /* keep the original error */
        }
      }
    });

  const changeSelection = () =>
    runBusy(async () => {
      if (await cancelPending()) {
        setStep('select');
        void loadMachine();
      }
    });

  const cancelOrder = () =>
    runBusy(async () => {
      if (await cancelPending()) {
        updateCart({});
        setStep('overview');
        void loadMachine();
      }
    });

  if (loadState === 'loading') return <Spinner />;
  if (loadState === 'notfound') {
    return (
      <Card className="text-center">
        <h1 className="text-2xl font-bold">Machine not found</h1>
        <p className="mt-2 text-slate-600">We couldn&apos;t find machine “{machineId}”. Please scan the QR code on the machine again.</p>
      </Card>
    );
  }
  if (loadState === 'error' || !machine || !summary) {
    return (
      <Card className="flex flex-col gap-3 text-center">
        <h1 className="text-xl font-bold">Couldn&apos;t load this machine</h1>
        <ErrorBox error={loadError} />
        <Button onClick={() => void loadMachine()}>Try again</Button>
      </Card>
    );
  }

  const available = machine.availability === 'AVAILABLE';

  return (
    <div className="flex flex-col gap-4">
      <MachineHeader machine={machine} />
      {loadError && <ErrorBox error={loadError} />}

      {step === 'overview' && (
        <>
          <PaymentModeBanner mode={machine.paymentMode} />
          <Card>
            <h2 className="mb-2 text-lg font-bold">Available liquids</h2>
            {liquids.filter((l) => l.available).length === 0 ? (
              <p className="text-slate-500">No liquids are available right now.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {liquids
                  .filter((l) => l.available)
                  .map((l) => (
                    <li key={l.id} className="py-2">
                      {l.name}
                    </li>
                  ))}
              </ul>
            )}
          </Card>
          {!available && (
            <Banner tone="grey">
              {machine.availability === 'BUSY'
                ? 'The machine is serving another order. Please wait a moment.'
                : 'The machine is not taking orders right now.'}
            </Banner>
          )}
          <Button size="lg" disabled={!available} onClick={() => setStep('select')}>
            Start order
          </Button>
          {!available && (
            <Button variant="secondary" onClick={() => void loadMachine()}>
              Refresh
            </Button>
          )}
        </>
      )}

      {step === 'select' && (
        <>
          <p className="text-sm text-slate-600">
            Choose up to {machine.limits.maxItems} liquids, max {machine.limits.maxTotalMl} mL in total. Prices are estimated — final price calculated by the machine.
          </p>
          <ul className="flex flex-col gap-2">
            {liquids.map((l) => {
              const line = summary.lines.find((x) => x.liquid.id === l.id);
              return (
                <LiquidRow
                  key={l.id}
                  liquid={l}
                  currency={machine.currency}
                  volumeMl={l.id in cart ? cart[l.id] : undefined}
                  error={line?.error ?? null}
                  estimatedPrice={line?.estimatedPrice ?? null}
                  onToggle={(sel) => toggle(l, sel)}
                  onChange={(v) => updateCart({ ...cart, [l.id]: v })}
                />
              );
            })}
          </ul>
          <CartSummaryCard
            summary={summary}
            machine={machine}
            onRemove={(id) => {
              const next = { ...cart };
              delete next[id];
              updateCart(next);
            }}
          />
          {!available && <Banner tone="grey">The machine is currently {machine.availability.toLowerCase().replace(/_/g, ' ')}. You can&apos;t order right now.</Banner>}
          <ErrorBox error={error} />
          <div className="sticky bottom-0 -mx-4 bg-slate-50/95 px-4 pb-4 pt-2 backdrop-blur">
            <Button size="lg" disabled={!summary.canSubmit || busy || !available} onClick={() => void proceedToReview()}>
              {busy ? 'Reserving machine…' : `Review order · ${formatMoney(summary.estimatedTotal, machine.currency)} (est.)`}
            </Button>
            <Button variant="ghost" className="mt-2 w-full" disabled={busy} onClick={() => setStep('overview')}>
              Back
            </Button>
          </div>
        </>
      )}

      {step === 'review' && order && (
        <ReviewStep order={order} busy={busy} error={error} onConfirm={(t) => void confirm(t)} onChangeSelection={() => void changeSelection()} onCancel={() => void cancelOrder()} />
      )}
    </div>
  );
}
