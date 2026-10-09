import type { MachinePublicView } from '@pegpal/shared';
import { AVAILABILITY_LABEL } from '@/lib/labels';
import { Badge } from '../ui';

export function MachineHeader({ machine }: { machine: MachinePublicView }) {
  const a = AVAILABILITY_LABEL[machine.availability];
  return (
    <header className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="truncate text-2xl font-bold">{machine.name}</h1>
        <p className="text-sm text-slate-500">Machine {machine.id}</p>
      </div>
      <Badge tone={a.tone} large>
        {a.label}
      </Badge>
    </header>
  );
}
