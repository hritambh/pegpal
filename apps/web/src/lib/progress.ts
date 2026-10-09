import { isTerminalStatus, type OrderItemView, type OrderStreamMessage, type OrderView } from '@pegpal/shared';

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/** Progress of one item as 0-100. Uses live progressMl, then deliveredMl. */
export function itemProgressPercent(item: Pick<OrderItemView, 'progressMl' | 'deliveredMl' | 'requestedMl' | 'status'>): number {
  if (item.requestedMl <= 0) return 0;
  const ml = item.progressMl ?? item.deliveredMl ?? (item.status === 'COMPLETED' ? item.requestedMl : 0);
  return clampPercent((ml / item.requestedMl) * 100);
}

/** Overall order progress 0-100, weighted by volume. */
export function orderProgressPercent(order: Pick<OrderView, 'items'>): number {
  const total = order.items.reduce((s, i) => s + i.requestedMl, 0);
  if (total <= 0) return 0;
  const done = order.items.reduce((s, i) => s + (itemProgressPercent(i) / 100) * i.requestedMl, 0);
  return clampPercent((done / total) * 100);
}

export interface ItemGroups {
  current: OrderItemView | null;
  completed: OrderItemView[];
  remaining: OrderItemView[];
  /** Items that ended in a non-success state (failed, stopped, skipped, unknown). */
  other: OrderItemView[];
}

export function groupItems(items: OrderItemView[]): ItemGroups {
  const sorted = [...items].sort((a, b) => a.position - b.position);
  return {
    current: sorted.find((i) => i.status === 'DISPENSING') ?? null,
    completed: sorted.filter((i) => i.status === 'COMPLETED'),
    remaining: sorted.filter((i) => i.status === 'PENDING'),
    other: sorted.filter((i) => i.status !== 'DISPENSING' && i.status !== 'COMPLETED' && i.status !== 'PENDING'),
  };
}

/** Parses an SSE payload. `eventName` is used when the JSON lacks a `type` (named SSE events). */
export function parseStreamMessage(data: string, eventName?: string): OrderStreamMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const type = typeof obj.type === 'string' ? obj.type : eventName;
  if (type === 'snapshot') {
    const order = (obj.order ?? (obj.id ? obj : null)) as OrderView | null;
    return order && typeof order === 'object' && Array.isArray(order.items) ? { type: 'snapshot', order } : null;
  }
  if (type === 'progress' && typeof obj.itemId === 'string') {
    return {
      type: 'progress',
      orderId: String(obj.orderId ?? ''),
      itemId: obj.itemId,
      progressMl: typeof obj.progressMl === 'number' ? obj.progressMl : null,
      massG: typeof obj.massG === 'number' ? obj.massG : null,
      simulated: obj.simulated === true,
    };
  }
  return null;
}

/** Applies a stream message to the current order. Progress never changes an item's status. */
export function applyStreamMessage(order: OrderView | null, msg: OrderStreamMessage): OrderView | null {
  if (msg.type === 'snapshot') {
    // Keep a newer live progress figure if the snapshot doesn't carry one for a still-running item.
    if (!order || order.id !== msg.order.id) return msg.order;
    const items = msg.order.items.map((item) => {
      if (item.status !== 'DISPENSING' || item.progressMl !== null) return item;
      const prev = order.items.find((p) => p.id === item.id);
      return prev && prev.status === 'DISPENSING' ? { ...item, progressMl: prev.progressMl } : item;
    });
    return { ...msg.order, items };
  }
  if (!order || (msg.orderId && msg.orderId !== order.id) || isTerminalStatus(order.status)) return order;
  let changed = false;
  const items = order.items.map((item) => {
    if (item.id !== msg.itemId || item.status !== 'DISPENSING') return item;
    changed = true;
    return { ...item, progressMl: msg.progressMl };
  });
  return changed ? { ...order, items } : order;
}
