import type { DispensingEventView } from '@pegpal/shared';
import { formatDateTime, shortId } from '@/lib/format';
import { Badge } from '../ui';
import { tdClass, thClass } from './MachineSelect';

const SEVERITY_TONE = { INFO: 'grey', WARN: 'amber', SAFETY: 'red' } as const;

export function EventsTable({ events, machineName }: { events: DispensingEventView[]; machineName?: (id: string | null) => string }) {
  if (events.length === 0) return <p className="py-3 text-sm text-slate-500">No events.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead>
          <tr>
            <th className={thClass}>Time</th>
            <th className={thClass}>Severity</th>
            <th className={thClass}>Type</th>
            <th className={thClass}>Machine</th>
            <th className={thClass}>Order</th>
            <th className={thClass}>Ch.</th>
            <th className={thClass}>Actor</th>
            <th className={thClass}>Details</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {events.map((e) => (
            <tr key={e.id}>
              <td className={tdClass}>{formatDateTime(e.createdAt)}</td>
              <td className={tdClass}>
                <Badge tone={SEVERITY_TONE[e.severity]}>{e.severity}</Badge>
              </td>
              <td className={`${tdClass} font-mono text-xs`}>{e.type}</td>
              <td className={tdClass}>{machineName ? machineName(e.machineId) : shortId(e.machineId)}</td>
              <td className={`${tdClass} font-mono text-xs`} title={e.orderId ?? undefined}>
                {shortId(e.orderId)}
              </td>
              <td className={tdClass}>{e.pumpChannel ?? '—'}</td>
              <td className={tdClass}>{e.actor ?? '—'}</td>
              <td className="max-w-md px-2 py-2 align-top">
                {e.payload !== null && e.payload !== undefined ? (
                  <details>
                    <summary className="cursor-pointer text-xs text-blue-700">payload</summary>
                    <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-slate-50 p-2 text-xs">{JSON.stringify(e.payload, null, 2)}</pre>
                  </details>
                ) : (
                  '—'
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
