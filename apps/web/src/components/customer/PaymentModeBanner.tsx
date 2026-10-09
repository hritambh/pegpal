import type { PaymentMode } from '@pegpal/shared';
import { Banner } from '../ui';

export function PaymentModeBanner({ mode }: { mode: PaymentMode }) {
  if (mode === 'TEST_MODE') {
    return (
      <Banner tone="amber" title="TEST MODE — no real payment is taken">
        This machine is running in test mode. You will not be charged and no money moves.
      </Banner>
    );
  }
  return (
    <Banner tone="blue" title="Internal testing — payment disabled">
      There is no payment step on this machine. You will not be charged.
    </Banner>
  );
}
