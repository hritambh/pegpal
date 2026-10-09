import Link from 'next/link';
import type { OrderView } from '@pegpal/shared';
import { formatDateTime, formatMl, formatMoney, shortId } from '@/lib/format';
import { ORDER_STATUS_LABEL } from '@/lib/labels';
import { Badge } from '../ui';
import { tdClass, thClass } from './MachineSelect';

export function OrdersTable({ orders }: { orders: OrderView[] }) {
  if (orders.length === 0) return <p className="py-3 text-sm text-slate-500">No orders yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead>
          <tr>
            <th className={thClass}>Created</th>
            <th className={thClass}>Order</th>
            <th className={thClass}>Machine</th>
            <th className={thClass}>Status</th>
            <th className={thClass}>Items</th>
            <th className={thClass}>Volume</th>
            <th className={thClass}>Price</th>
            <th className={thClass}>Payment</th>
            <th className={thClass}>Failure</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {orders.map((o) => (
            <tr key={o.id}>
              <td className={tdClass}>{formatDateTime(o.createdAt)}</td>
              <td className={`${tdClass} font-mono text-xs`}>
                <Link className="text-blue-700 underline" href={`/order/${encodeURIComponent(o.id)}`} title={o.id}>
                  {shortId(o.id)}
                </Link>
              </td>
              <td className={tdClass}>{o.machineName}</td>
              <td className={tdClass}>
                <Badge tone={ORDER_STATUS_LABEL[o.status].tone}>{o.status}</Badge>
                {o.cancelRequested && <span className="ml-1 text-xs text-amber-700">cancel requested</span>}
              </td>
              <td className={tdClass}>{o.items.map((i) => `${i.liquidName} ${i.requestedMl}mL (${i.status})`).join(', ')}</td>
              <td className={tdClass}>{formatMl(o.totalVolumeMl)}</td>
              <td className={tdClass}>{formatMoney(o.totalPrice, o.currency)}</td>
              <td className={tdClass}>
                {o.payment.status}
                {o.payment.isTest && <span className="ml-1 text-xs font-semibold text-amber-700">TEST</span>}
              </td>
              <td className="max-w-xs px-2 py-2 align-top text-xs text-red-700">{o.failureReason ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
