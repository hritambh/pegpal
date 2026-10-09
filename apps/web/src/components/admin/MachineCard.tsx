'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { AdminMachineView } from '@pegpal/shared';
import { adminApi, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { AVAILABILITY_LABEL, CONNECTION_LABEL, SERVICE_STATUS_LABEL } from '@/lib/labels';
import { ConfirmDialog } from '../ConfirmDialog';
import { Badge, Banner, Button, Card, ErrorBox } from '../ui';

type DialogKind = 'stop' | 'clear' | null;

export function MachineCard({ machine, onChanged }: { machine: AdminMachineView; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogKind>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const svc = SERVICE_STATUS_LABEL[machine.status];
  const avail = AVAILABILITY_LABEL[machine.availability];
  const conn = CONNECTION_LABEL[machine.hardwareConnection];

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-lg font-bold">{machine.name}</h3>
          <p className="font-mono text-xs text-slate-500">
            {machine.publicId} · {machine.id}
          </p>
        </div>
        <div className="flex flex-wrap gap-1">
          <Badge tone={svc.tone}>{svc.label}</Badge>
          <Badge tone={avail.tone}>{avail.label}</Badge>
          <Badge tone={conn.tone}>{conn.label}</Badge>
        </div>
      </div>

      {machine.estopActive && (
        <Banner tone="red" title="EMERGENCY STOP ACTIVE">
          The physical e-stop is engaged. It must be released at the machine; it cannot be cleared from here.
        </Banner>
      )}
      {machine.faultReason && <Banner tone="red" title="Fault">{machine.faultReason}</Banner>}

      <dl className="grid grid-cols-2 gap-1 text-sm">
        <dt className="text-slate-600">Current order</dt>
        <dd>
          {machine.activeOrderId ? (
            <Link className="font-mono text-xs text-blue-700 underline" href={`/order/${encodeURIComponent(machine.activeOrderId)}`}>
              {machine.activeOrderId}
            </Link>
          ) : (
            '—'
          )}
        </dd>
        <dt className="text-slate-600">Calibration run</dt>
        <dd className="font-mono text-xs">{machine.activeCalibrationRunId ?? '—'}</dd>
        <dt className="text-slate-600">Last seen</dt>
        <dd>{formatDateTime(machine.lastSeenAt)}</dd>
      </dl>

      <ErrorBox error={error} />

      <div className="flex flex-wrap gap-2">
        {machine.status === 'OUT_OF_SERVICE' ? (
          <Button size="sm" disabled={busy} onClick={() => void run(() => adminApi.setMachineStatus(machine.id, 'IN_SERVICE'))}>
            Set in service
          </Button>
        ) : (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void run(() => adminApi.setMachineStatus(machine.id, 'OUT_OF_SERVICE'))}>
            Set out of service
          </Button>
        )}
        <Button size="sm" variant="danger" disabled={busy} onClick={() => setDialog('stop')}>
          Stop all pumps
        </Button>
        {(machine.status === 'NEEDS_ATTENTION' || machine.faultReason) && (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => setDialog('clear')}>
            Clear fault
          </Button>
        )}
      </div>

      <ConfirmDialog
        open={dialog === 'stop'}
        title="Stop all pumps?"
        message={`Sends a software STOP to every pump on ${machine.name}. Any running order will be stopped. This is not a substitute for the physical e-stop.`}
        confirmLabel="Stop all pumps"
        danger
        inputLabel="Reason"
        inputDefault="Operator stop from dashboard"
        inputRequired
        onCancel={() => setDialog(null)}
        onConfirm={(reason) => {
          setDialog(null);
          void run(() => adminApi.stopMachine(machine.id, reason));
        }}
      />
      <ConfirmDialog
        open={dialog === 'clear'}
        title="Clear fault?"
        message="Only clear the fault after inspecting the machine. The server requires a fresh controller status with no pump running and no e-stop."
        confirmLabel="Clear fault"
        inputLabel="Inspection note"
        inputRequired
        onCancel={() => setDialog(null)}
        onConfirm={(note) => {
          setDialog(null);
          void run(() => adminApi.clearFault(machine.id, note));
        }}
      />
    </Card>
  );
}
