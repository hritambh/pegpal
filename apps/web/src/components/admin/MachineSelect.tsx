'use client';

import type { AdminMachineView } from '@pegpal/shared';

export function MachineSelect({
  machines,
  value,
  onChange,
  allowAll,
}: {
  machines: AdminMachineView[];
  value: string;
  onChange: (id: string) => void;
  allowAll?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm font-medium">
      Machine
      <select className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-base" value={value} onChange={(e) => onChange(e.target.value)}>
        {allowAll && <option value="">All machines</option>}
        {machines.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name} ({m.publicId})
          </option>
        ))}
      </select>
    </label>
  );
}

export const inputClass = 'rounded-lg border border-slate-300 bg-white px-3 py-2 text-base';
export const thClass = 'whitespace-nowrap px-2 py-2 text-left text-xs font-semibold uppercase text-slate-500';
export const tdClass = 'whitespace-nowrap px-2 py-2 align-top';
