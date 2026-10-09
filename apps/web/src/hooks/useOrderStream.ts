'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { isTerminalStatus, type OrderView } from '@pegpal/shared';
import { ApiRequestError, customerApi, errorMessage } from '@/lib/api';
import { applyStreamMessage, parseStreamMessage } from '@/lib/progress';

const POLL_MS = 2000;

export type StreamMode = 'connecting' | 'live' | 'polling' | 'closed';

/**
 * Follows an order over SSE (`snapshot` + `progress`), falling back to polling
 * GET /api/orders/:id every 2s when the stream errors. Stops once the order is terminal.
 */
export function useOrderStream(orderId: string) {
  const [order, setOrder] = useState<OrderView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [mode, setMode] = useState<StreamMode>('connecting');
  const orderRef = useRef<OrderView | null>(null);

  const apply = useCallback((updater: (prev: OrderView | null) => OrderView | null) => {
    const next = updater(orderRef.current);
    orderRef.current = next;
    setOrder(next);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const o = await customerApi.getOrder(orderId);
      apply((prev) => applyStreamMessage(prev, { type: 'snapshot', order: o }));
      setError(null);
      return o;
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 404) setNotFound(true);
      else setError(errorMessage(err));
      return null;
    }
  }, [orderId, apply]);

  useEffect(() => {
    let disposed = false;
    let es: EventSource | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    const done = () => orderRef.current !== null && isTerminalStatus(orderRef.current.status);

    const poll = async () => {
      if (disposed) return;
      const o = await refresh();
      if (disposed) return;
      if (o && isTerminalStatus(o.status)) {
        setMode('closed');
        return;
      }
      pollTimer = setTimeout(() => void poll(), POLL_MS);
    };

    const startPolling = () => {
      if (disposed || pollTimer !== null) return;
      setMode('polling');
      void poll();
    };

    const handle = (data: string, eventName?: string) => {
      const msg = parseStreamMessage(data, eventName);
      if (!msg) return;
      apply((prev) => applyStreamMessage(prev, msg));
      setError(null);
      setMode('live');
      if (done()) {
        es?.close();
        setMode('closed');
      }
    };

    // Load once straight away so the page renders even if SSE is slow or unsupported.
    void refresh().then((o) => {
      if (disposed || !o) return;
      if (isTerminalStatus(o.status)) {
        setMode('closed');
        return;
      }
      if (typeof EventSource === 'undefined') {
        startPolling();
        return;
      }
      es = new EventSource(customerApi.orderEventsUrl(orderId));
      es.onmessage = (e) => handle(e.data);
      es.addEventListener('snapshot', (e) => handle((e as MessageEvent<string>).data, 'snapshot'));
      es.addEventListener('progress', (e) => handle((e as MessageEvent<string>).data, 'progress'));
      es.onerror = () => {
        es?.close();
        es = null;
        if (done()) {
          setMode('closed');
          return;
        }
        startPolling();
      };
    });

    return () => {
      disposed = true;
      es?.close();
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [orderId, refresh, apply]);

  return { order, error, notFound, mode, refresh, setOrder: (o: OrderView) => apply(() => o) };
}
