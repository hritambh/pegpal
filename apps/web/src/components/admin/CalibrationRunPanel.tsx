'use client';

import { useState } from 'react';
import type { CalibrationRunView } from '@pegpal/shared';
import { adminApi, errorMessage } from '@/lib/api';
import { formatNumber } from '@/lib/format';
import { usePolling } from '@/hooks/usePolling';
import { Badge, Banner, Button, Card, ErrorBox, Spinner } from '../ui';
import { inputClass } from './MachineSelect';

export const SIMULATED_LABEL = 'SIMULATED — not a real measurement';

export function CalibrationRunPanel({ runId, onChanged, onClose }: { runId: string; onChanged: () => void; onClose: () => void }) {
  const [stopPolling, setStopPolling] = useState(false);
  const run = usePolling(
    async () => {
      const r = await adminApi.calibrationRun(runId);
      if (r.status !== 'RUNNING') setStopPolling(true);
      return r;
    },
    stopPolling ? 0 : 1000,
    [runId],
  );
  const [measuredMl, setMeasuredMl] = useState('');
  const [massG, setMassG] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<string | null>(null);

  const r = run.data;
  if (!r) return run.error ? <ErrorBox error={run.error} /> : <Spinner />;

  const act = async (fn: () => Promise<CalibrationRunView | null>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await fn();
      if (next) run.setData(next);
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const submitMeasurement = (e: React.FormEvent) => {
    e.preventDefault();
    const ml = Number(measuredMl);
    if (!Number.isFinite(ml) || ml <= 0) {
      setError('Measured volume must be a positive number');
      return;
    }
    let mass: number | undefined;
    if (massG.trim() !== '') {
      mass = Number(massG);
      if (!Number.isFinite(mass) || mass <= 0) {
        setError('Mass must be a positive number');
        return;
      }
    }
    void act(() => adminApi.submitMeasurement(r.id, mass === undefined ? { measuredMl: ml } : { measuredMl: ml, measuredMassG: mass }));
  };

  return (
    <Card className={`flex flex-col gap-3 ${r.simulated ? 'border-2 border-dashed border-amber-400' : ''}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-bold">
          {r.kind === 'FLOW_RATE' ? 'Flow-rate calibration' : 'Validation run'} — {r.liquidName} (ch. {r.pumpChannel})
        </h2>
        <div className="flex gap-1">
          {r.simulated && <Badge tone="amber">{SIMULATED_LABEL}</Badge>}
          <Badge tone={r.status === 'FAILED' ? 'red' : r.status === 'COMPLETED' ? 'green' : 'blue'}>{r.status}</Badge>
        </div>
      </div>
      <p className="text-sm text-slate-600">
        {r.kind === 'FLOW_RATE' ? `Commanded runtime ${r.commandedRuntimeMs ?? '—'} ms` : `Target ${r.targetMl ?? '—'} mL`}
        {r.actualRuntimeMs !== null && ` · actual runtime ${r.actualRuntimeMs} ms`}
      </p>

      {r.status === 'RUNNING' && <Spinner label="Pump running… collect the output in a graduated cylinder." />}

      {r.status === 'AWAITING_MEASUREMENT' && (
        <form onSubmit={submitMeasurement} className="flex flex-col gap-3">
          {r.simulated && (
            <Banner tone="amber" title={SIMULATED_LABEL}>
              Simulator reading: {r.simulatedReadingMl !== null ? `${formatNumber(r.simulatedReadingMl, 2)} mL` : '—'} (enter it below to complete the simulated run).
            </Banner>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm font-medium">
              Measured volume (mL, graduated cylinder)
              <input className={inputClass} inputMode="decimal" value={measuredMl} onChange={(e) => setMeasuredMl(e.target.value)} required />
            </label>
            <label className="flex flex-col gap-1 text-sm font-medium">
              Measured mass (g, optional — for density)
              <input className={inputClass} inputMode="decimal" value={massG} onChange={(e) => setMassG(e.target.value)} />
            </label>
          </div>
          <Button type="submit" disabled={busy}>
            Submit measurement
          </Button>
        </form>
      )}

      {r.status === 'COMPLETED' && (
        <dl className="grid grid-cols-2 gap-1 text-sm sm:grid-cols-4">
          <dt className="text-slate-600">Measured</dt>
          <dd>{formatNumber(r.measuredMl, 2)} mL</dd>
          <dt className="text-slate-600">Mass</dt>
          <dd>{r.measuredMassG !== null ? `${formatNumber(r.measuredMassG, 2)} g` : '—'}</dd>
          <dt className="text-slate-600">Computed flow rate</dt>
          <dd>{r.computedFlowRate !== null ? `${formatNumber(r.computedFlowRate, 3)} mL/s` : '—'}</dd>
          <dt className="text-slate-600">Previous flow rate</dt>
          <dd>{r.previousFlowRate !== null ? `${formatNumber(r.previousFlowRate, 3)} mL/s` : '—'}</dd>
          <dt className="text-slate-600">Computed density</dt>
          <dd>{r.computedDensity !== null ? `${formatNumber(r.computedDensity, 3)} g/mL` : '—'}</dd>
          <dt className="text-slate-600">Error</dt>
          <dd>{r.errorPct !== null ? `${formatNumber(r.errorPct, 1)} %` : '—'}</dd>
        </dl>
      )}

      {r.status === 'FAILED' && <Banner tone="red" title="Run failed">{r.failureReason ?? 'Unknown reason'}</Banner>}

      {r.kind === 'FLOW_RATE' && r.status === 'COMPLETED' && !r.applied && (
        <Button
          disabled={busy}
          onClick={() =>
            void act(async () => {
              const l = await adminApi.applyCalibration(r.id);
              setApplied(`Applied: ${l.name} flow rate is now ${formatNumber(l.flowRateMlPerSec, 3)} mL/s${l.calibrationSimulated ? ` (${SIMULATED_LABEL})` : ''}`);
              return adminApi.calibrationRun(r.id);
            })
          }
        >
          Apply flow rate to {r.liquidName}
        </Button>
      )}
      {r.applied && <Banner tone="green">{applied ?? 'This calibration has been applied.'}</Banner>}
      <ErrorBox error={error} />
      <Button variant="ghost" onClick={onClose}>
        Close
      </Button>
    </Card>
  );
}
