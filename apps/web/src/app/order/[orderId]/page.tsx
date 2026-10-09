import { OrderTracker } from '@/components/customer/OrderTracker';

export const dynamic = 'force-dynamic';

export default async function OrderPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  return (
    <main className="mx-auto w-full max-w-lg px-4 py-5">
      <OrderTracker orderId={orderId} />
    </main>
  );
}
