import { MachineFlow } from '@/components/customer/MachineFlow';

export const dynamic = 'force-dynamic';

export default async function MachinePage({ params }: { params: Promise<{ machineId: string }> }) {
  const { machineId } = await params;
  return (
    <main className="mx-auto w-full max-w-lg px-4 py-5">
      <MachineFlow machineId={safeDecode(machineId)} />
    </main>
  );
}

function safeDecode(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}
