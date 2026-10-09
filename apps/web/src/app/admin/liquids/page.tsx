'use client';

import { useEffect, useState } from 'react';
import type { AdminLiquidView } from '@pegpal/shared';
import { adminApi } from '@/lib/api';
import { formatDateTime, formatNumber } from '@/lib/format';
import { usePolling } from '@/hooks/usePolling';
import { LiquidForm } from '@/components/admin/LiquidForm';
import { MachineSelect, tdClass, thClass } from '@/components/admin/MachineSelect';
import { Badge, Button, Card, ErrorBox, Spinner } from '@/components/ui';

export default function AdminLiquidsPage() {
  const overview = usePolling(() => adminApi.overview(), 0);
  const machines = overview.data?.machines ?? [];
  const [machineId, setMachineId] = useState('');
  const [editing, setEditing] = useState<AdminLiquidView | null | 'new'>(null);

  const firstMachineId = overview.data?.machines[0]?.id;
  useEffect(() => {
    if (!machineId && firstMachineId) setMachineId(firstMachineId);
  }, [machineId, firstMachineId]);

  const liquids = usePolling(() => (machineId ? adminApi.liquids(machineId) : Promise.resolve([] as AdminLiquidView[])), 0, [machineId]);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-bold">Liquids &amp; pump mapping</h1>
      <ErrorBox error={overview.error} />
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-64">
          <MachineSelect
            machines={machines}
            value={machineId}
            onChange={(id) => {
              setMachineId(id);
              setEditing(null);
            }}
          />
        </div>
        <Button disabled={!machineId} onClick={() => setEditing('new')}>
          Add liquid
        </Button>
      </div>

      {editing !== null && machineId && (
        <LiquidForm
          key={editing === 'new' ? 'new' : editing.id}
          machineId={machineId}
          editing={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void liquids.reload();
          }}
        />
      )}

      <Card>
        <ErrorBox error={liquids.error} />
        {liquids.loading && !liquids.data ? (
          <Spinner />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr>
                  {['Ch.', 'Name', 'Strategy', 'Density g/mL', 'Flow mL/s', 'Cutoff g', 'Min–max mL', 'Price/mL', 'Stock mL', 'Active', 'Calibrated', ''].map((h) => (
                    <th key={h} className={thClass}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {(liquids.data ?? [])
                  .slice()
                  .sort((a, b) => a.pumpChannel - b.pumpChannel)
                  .map((l) => (
                    <tr key={l.id} className={l.active ? '' : 'text-slate-400'}>
                      <td className={`${tdClass} font-bold`}>{l.pumpChannel}</td>
                      <td className={tdClass}>{l.name}</td>
                      <td className={tdClass}>{l.strategy}</td>
                      <td className={tdClass}>{formatNumber(l.densityGPerMl, 3)}</td>
                      <td className={tdClass}>{formatNumber(l.flowRateMlPerSec, 3)}</td>
                      <td className={tdClass}>{formatNumber(l.cutoffMarginG, 1)}</td>
                      <td className={tdClass}>
                        {l.minMl}–{l.maxMl}
                      </td>
                      <td className={tdClass}>{l.pricePerMl}</td>
                      <td className={tdClass}>{l.remainingStockMl ?? 'untracked'}</td>
                      <td className={tdClass}>{l.active ? <Badge tone="green">Active</Badge> : <Badge tone="grey">Inactive</Badge>}</td>
                      <td className={tdClass}>
                        {l.calibratedAt ? formatDateTime(l.calibratedAt) : <Badge tone="red">Not calibrated</Badge>}
                        {l.calibrationSimulated && (
                          <span className="ml-1">
                            <Badge tone="amber">SIMULATED</Badge>
                          </span>
                        )}
                      </td>
                      <td className={tdClass}>
                        <Button size="sm" variant="secondary" onClick={() => setEditing(l)}>
                          Edit
                        </Button>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
            {liquids.data?.length === 0 && <p className="py-3 text-sm text-slate-500">No liquids on this machine.</p>}
          </div>
        )}
      </Card>
    </div>
  );
}
