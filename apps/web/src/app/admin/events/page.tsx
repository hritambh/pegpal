'use client';

import { useState } from 'react';
import { adminApi } from '@/lib/api';
import { usePolling } from '@/hooks/usePolling';
import { EventsTable } from '@/components/admin/EventsTable';
import { MachineSelect, inputClass } from '@/components/admin/MachineSelect';
import { Button, Card, ErrorBox, Spinner } from '@/components/ui';

export default function AdminEventsPage() {
  const overview = usePolling(() => adminApi.overview(), 0);
  const [machineId, setMachineId] = useState('');
  const [orderInput, setOrderInput] = useState('');
  const [orderId, setOrderId] = useState('');
  const [severity, setSeverity] = useState('');
  const machines = overview.data?.machines ?? [];

  const events = usePolling(
    () => adminApi.events({ machineId: machineId || undefined, orderId: orderId || undefined, severity: severity || undefined, limit: 200 }),
    5000,
    [machineId, orderId, severity],
  );

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-bold">Dispensing log</h1>
      <Card>
        <form
          className="grid grid-cols-1 items-end gap-3 sm:grid-cols-4"
          onSubmit={(e) => {
            e.preventDefault();
            setOrderId(orderInput.trim());
          }}
        >
          <MachineSelect machines={machines} value={machineId} onChange={setMachineId} allowAll />
          <label className="flex flex-col gap-1 text-sm font-medium">
            Order id
            <input className={inputClass} value={orderInput} onChange={(e) => setOrderInput(e.target.value)} placeholder="any" />
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium">
            Severity
            <select className={inputClass} value={severity} onChange={(e) => setSeverity(e.target.value)}>
              <option value="">All</option>
              <option value="INFO">INFO</option>
              <option value="WARN">WARN</option>
              <option value="SAFETY">SAFETY</option>
            </select>
          </label>
          <Button type="submit">Apply</Button>
        </form>
      </Card>
      <Card>
        <ErrorBox error={events.error ?? overview.error} />
        {events.data ? <EventsTable events={events.data} machineName={(id) => machines.find((m) => m.id === id)?.name ?? id ?? '—'} /> : <Spinner />}
      </Card>
    </div>
  );
}
