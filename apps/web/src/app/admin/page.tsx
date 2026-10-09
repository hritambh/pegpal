'use client';

import { adminApi } from '@/lib/api';
import { hardwareModeLabel } from '@/lib/labels';
import { usePolling } from '@/hooks/usePolling';
import { EventsTable } from '@/components/admin/EventsTable';
import { MachineCard } from '@/components/admin/MachineCard';
import { MockPanel } from '@/components/admin/MockPanel';
import { OrdersTable } from '@/components/admin/OrdersTable';
import { Badge, Banner, Card, ErrorBox, Spinner } from '@/components/ui';

async function loadAlerts() {
  const [safety, warn] = await Promise.all([adminApi.events({ severity: 'SAFETY', limit: 20 }), adminApi.events({ severity: 'WARN', limit: 20 })]);
  return [...safety, ...warn].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 25);
}

export default function AdminDashboardPage() {
  const overview = usePolling(() => adminApi.overview(), 3000);
  const orders = usePolling(() => adminApi.orders({ limit: 20 }), 5000);
  const alerts = usePolling(loadAlerts, 5000);

  const o = overview.data;
  if (!o) return overview.error ? <ErrorBox error={overview.error} /> : <Spinner />;

  const hw = hardwareModeLabel(o.hardwareMode);
  const nameOf = (id: string | null) => o.machines.find((m) => m.id === id)?.name ?? id ?? '—';

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <span className={`rounded-xl px-4 py-2 text-lg font-extrabold ${o.hardwareMode === 'mock' ? 'bg-amber-400 text-amber-950' : 'bg-red-600 text-white'}`}>
          {hw.label}
        </span>
        <Badge tone={o.paymentMode === 'TEST_MODE' ? 'amber' : 'blue'} large>
          Payment: {o.paymentMode === 'TEST_MODE' ? 'TEST MODE (no real payment)' : 'DISABLED (internal testing)'}
        </Badge>
      </div>
      {o.hardwareMode === 'esp32' && (
        <Banner tone="red" title="Physical hardware">
          Pump commands on this dashboard drive real pumps.
        </Banner>
      )}
      <ErrorBox error={overview.error} />

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-bold">Machines</h2>
        {o.machines.length === 0 && <p className="text-slate-500">No machines configured.</p>}
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {o.machines.map((m) => (
            <MachineCard key={m.id} machine={m} onChanged={() => void overview.reload()} />
          ))}
        </div>
      </section>

      {o.hardwareMode === 'mock' && (
        <section className="flex flex-col gap-3">
          <h2 className="text-xl font-bold">Simulator</h2>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {o.machines.map((m) => (
              <MockPanel key={m.id} machine={m} />
            ))}
          </div>
        </section>
      )}

      <Card>
        <h2 className="mb-2 text-xl font-bold">Safety &amp; error events</h2>
        <ErrorBox error={alerts.error} />
        {alerts.data ? <EventsTable events={alerts.data} machineName={nameOf} /> : <Spinner />}
      </Card>

      <Card>
        <h2 className="mb-2 text-xl font-bold">Recent orders</h2>
        <ErrorBox error={orders.error} />
        {orders.data ? <OrdersTable orders={orders.data} /> : <Spinner />}
      </Card>
    </div>
  );
}
