import { HttpException, HttpStatus } from '@nestjs/common';

/** HttpException carrying a stable machine-readable code. */
export class AppError extends HttpException {
  constructor(
    status: HttpStatus,
    readonly code: string,
    message: string,
    readonly details?: string[],
  ) {
    super({ message, code, details }, status);
  }
}

export const Errors = {
  machineNotFound: () => new AppError(HttpStatus.NOT_FOUND, 'MACHINE_NOT_FOUND', 'Machine not found'),
  orderNotFound: () => new AppError(HttpStatus.NOT_FOUND, 'ORDER_NOT_FOUND', 'Order not found'),
  liquidNotFound: () => new AppError(HttpStatus.NOT_FOUND, 'LIQUID_NOT_FOUND', 'Liquid not found'),
  machineBusy: () => new AppError(HttpStatus.CONFLICT, 'MACHINE_BUSY', 'Machine is busy with another order'),
  machineUnavailable: (reason: string) =>
    new AppError(HttpStatus.UNPROCESSABLE_ENTITY, 'MACHINE_UNAVAILABLE', `Machine is not available: ${reason}`),
  invalidTransition: (from: string, to: string) =>
    new AppError(HttpStatus.CONFLICT, 'INVALID_TRANSITION', `Order cannot move from ${from} to ${to}`),
  idempotencyConflict: () =>
    new AppError(
      HttpStatus.CONFLICT,
      'IDEMPOTENCY_KEY_REUSED',
      'Idempotency-Key was already used with a different request body',
    ),
  invalidOrder: (details: string[]) =>
    new AppError(HttpStatus.UNPROCESSABLE_ENTITY, 'INVALID_ORDER', 'Order is not valid', details),
  badOrderToken: () => new AppError(HttpStatus.UNAUTHORIZED, 'INVALID_ORDER_TOKEN', 'Missing or invalid order token'),
  paymentRequired: () =>
    new AppError(
      HttpStatus.UNPROCESSABLE_ENTITY,
      'TEST_PAYMENT_NOT_CONFIRMED',
      'TEST_MODE requires testPaymentConfirmed=true (simulated payment; no money is taken)',
    ),
  hardwareUnavailable: (reason: string) =>
    new AppError(HttpStatus.SERVICE_UNAVAILABLE, 'HARDWARE_UNAVAILABLE', reason),
  conflict: (code: string, message: string) => new AppError(HttpStatus.CONFLICT, code, message),
  unprocessable: (code: string, message: string) => new AppError(HttpStatus.UNPROCESSABLE_ENTITY, code, message),
  notFound: (code: string, message: string) => new AppError(HttpStatus.NOT_FOUND, code, message),
};
