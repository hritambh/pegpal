'use client';

import { useEffect, useState } from 'react';
import type { AdminLiquidView, CalibrationKind } from '@pegpal/shared';
import { adminApi, errorMessage } from '@/lib/api';
import { formatDateTime, formatNumber } from '@/lib/format';
import { usePolling } from '@/hooks/usePolling';
import { CalibrationRunPanel, SIMULATED_LABEL } from '@/components/admin/CalibrationRunPanel';
import { MachineSelect, inputClass, tdClass, thClass } from '@/components/admin/MachineSelect';
import { Badge, Button, Card, ErrorBox, Spinner } from '@/components/ui';

export default function AdminCalibrationPage() {
  const overview = usePolling(() => adminApi.overview(), 0);
  const machines = overview.data?.machines ?? [];
  const [machineId, setMachineId] = useState('');
  const [liquidId, setLiquidId] = useState('');
  const [kind, setKind] = useState<CalibrationKind>('FLOW_RATE');
  const [runtimeMs, setRuntimeMs] = useState('10000');
  const [targetMl, setTargetMl] = useState('50');
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const firstMachineId = overview.data?.machines[0]?.id;
  useEffect(() => {
    if (!machineId && firstMachineId) setMachineId(firstMachineId);
  }, [machineId, firstMachineId]);

  const liquids = usePolling(() => (machineId ? adminApi.liquids(machineId) : Promise.resolve([] as AdminLiquidView[])), 0, [machineId]);
  const history = usePolling(() => (liquidId ? adminApi.calibrationRuns({ liquidId, limit: 20 }) : Promise.resolve([])), 0, [liquidId]);

  useEffect(() => {
    const list = liquids.data ?? [];
    if (list.length > 0 && !list.some((l) => l.id === liquidId)) setLiquidId(list[0].id);
  }, [liquids.data, liquidId]);

  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!liquidId || busy) return;
    const value = Number(kind === 'FLOW_RATE' ? runtimeMs : targetMl);
    if (!Number.isInteger(value) || value <= 0) {
      setError(kind === 'FLOW_RATE' ? 'Runtime must be a positive whole number of ms' : 'Target must be a positive whole number of mL');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const run = await adminApi.startCalibration(kind === 'FLOW_RATE' ? { liquidId, kind, runtimeMs: value } : { liquidId, kind, targetMl: value });
      setActiveRunId(run.id);
      void history.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-bold">Calibration</h1>
      <ErrorBox error={overview.error ?? liquids.error} />
      <Card>
        <form onSubmit={start} className="grid grid-cols-1 items-end gap-3 sm:grid-cols-4">
          <MachineSelect machines={machines} value={machineId} onChange={setMachineId} />
          <label className="flex flex-col gap-1 text-sm font-medium">
            Liquid
            <select className={inputClass} value={liquidId} onChange={(e) => setLiquidId(e.target.value)}>
              {(liquids.data ?? []).map((l) => (
                <option key={l.id} value={l.id}>
                  ch.{l.pumpChannel} {l.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium">
            Run type
            <select className={inputClass} value={kind} onChange={(e) => setKind(e.target.value as CalibrationKind)}>
              <option value="FLOW_RATE">FLOW_RATE (fixed runtime)</option>
              <option value="VALIDATION">VALIDATION (target volume)</option>
            </select>
          </label>
          {kind === 'FLOW_RATE' ? (
            <label className="flex flex-col gap-1 text-sm font-medium">
              Runtime (ms)
              <input className={inputClass} inputMode="numeric" value={runtimeMs} onChange={(e) => setRuntimeMs(e.target.value)} />
            </label>
          ) : (
            <label className="flex flex-col gap-1 text-sm font-medium">
              Target (mL)
              <input className={inputClass} inputMode="numeric" value={targetMl} onChange={(e) => setTargetMl(e.target.value)} />
            </label>
          )}
          <div className="sm:col-span-4">
            <Button type="submit" disabled={busy || !liquidId || activeRunId !== null}>
              {busy ? 'Starting…' : 'Start run (pump will run)'}
            </Button>
          </div>
        </form>
        <ErrorBox error={error} />
      </Card>

      {activeRunId && (
        <CalibrationRunPanel
          key={activeRunId}
          runId={activeRunId}
          onChanged={() => {
            void history.reload();
            void liquids.reload();
          }}
          onClose={() => setActiveRunId(null)}
        />
      )}

      <Card>
        <h2 className="mb-2 text-lg font-bold">History</h2>
        <ErrorBox error={history.error} />
        {!history.data ? (
          <Spinner />
        ) : history.data.length === 0 ? (
          <p className="text-sm text-slate-500">No runs for this liquid.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr>
                  {['Started', 'Kind', 'Status', 'Requested', 'Measured mL', 'Mass g', 'Flow mL/s', 'Density', 'Error %', 'Applied', 'Operator', ''].map((h) => (
                    <th key={h} className={thClass}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {history.data.map((r) => (
                  <tr key={r.id} className={r.simulated ? 'bg-amber-50' : ''}>
                    <td className={tdClass}>
                      {formatDateTime(r.createdAt)}
                      {r.simulated && <div className="text-xs font-semibold text-amber-800">{SIMULATED_LABEL}</div>}
                    </td>
                    <td className={tdClass}>{r.kind}</td>
                    <td className={tdClass}>
                      <Badge tone={r.status === 'FAILED' ? 'red' : r.status === 'COMPLETED' ? 'green' : 'blue'}>{r.status}</Badge>
                    </td>
                    <td className={tdClass}>{r.kind === 'FLOW_RATE' ? `${r.commandedRuntimeMs ?? '—'} ms` : `${r.targetMl ?? '—'} mL`}</td>
                    <td className={tdClass}>{formatNumber(r.measuredMl, 2)}</td>
                    <td className={tdClass}>{formatNumber(r.measuredMassG, 2)}</td>
                    <td className={tdClass}>
                      {formatNumber(r.computedFlowRate, 3)}
                      {r.previousFlowRate !== null && <span className="text-xs text-slate-500"> (was {formatNumber(r.previousFlowRate, 3)})</span>}
                    </td>
                    <td className={tdClass}>{formatNumber(r.computedDensity, 3)}</td>
                    <td className={tdClass}>{formatNumber(r.errorPct, 1)}</td>
                    <td className={tdClass}>{r.applied ? 'yes' : 'no'}</td>
                    <td className={tdClass}>{r.operator}</td>
                    <td className={tdClass}>
                      <Button size="sm" variant="secondary" onClick={() => setActiveRunId(r.id)}>
                        Open
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
