/**
 * HTTP response/request shapes shared by the API and the web app.
 * Normative description: docs/api.md.
 */
import type { OrderItemStatus, OrderStatus, VerificationLevel } from './order-state';
import type { DispenseStrategy } from './protocol';

export type PaymentMode = 'TEST_MODE' | 'PAYMENT_DISABLED';
export type HardwareMode = 'mock' | 'esp32';

/** Customer-facing availability, derived from operator status, connection, e-stop and reservation. */
export type MachineAvailability = 'AVAILABLE' | 'BUSY' | 'OFFLINE' | 'OUT_OF_SERVICE';

/** Operator-controlled status stored on the machine. */
export type MachineServiceStatus = 'IN_SERVICE' | 'OUT_OF_SERVICE' | 'NEEDS_ATTENTION';
export type HardwareConnection = 'CONNECTED' | 'DISCONNECTED' | 'UNKNOWN';

export interface ApiError {
  statusCode: number;
  error: string;
  /** Stable machine-readable code, e.g. MACHINE_BUSY, INVALID_TRANSITION. */
  code?: string;
  message: string;
  /** Field-level validation messages, when applicable. */
  details?: string[];
  requestId?: string;
}

// ---------------------------------------------------------------- public

export interface MachinePublicView {
  /** Public identifier printed in the QR URL, e.g. MACHINE_001. */
  id: string;
  name: string;
  availability: MachineAvailability;
  currency: string;
  paymentMode: PaymentMode;
  limits: { maxTotalMl: number; maxItems: number };
}

export interface LiquidPublicView {
  id: string;
  name: string;
  imageUrl: string | null;
  /** Decimal string in machine currency, e.g. "0.0500". */
  pricePerMl: string;
  minMl: number;
  maxMl: number;
  available: boolean;
  unavailableReason: string | null;
}

export interface CreateOrderItemRequest {
  liquidId: string;
  volumeMl: number;
}

/** POST /api/orders. Requires an `Idempotency-Key` header (8-128 chars). */
export interface CreateOrderRequest {
  machineId: string;
  items: CreateOrderItemRequest[];
}

export interface CreateOrderResponse {
  order: OrderView;
  /** Bearer secret for confirm/cancel; send as `X-Order-Token`. */
  orderToken: string;
}

/** POST /api/orders/:id/confirm */
export interface ConfirmOrderRequest {
  /** TEST_MODE only: explicit simulated-payment confirmation. No money moves. */
  testPaymentConfirmed?: boolean;
}

export type PaymentStatus = 'PENDING' | 'TEST_CONFIRMED' | 'NOT_REQUIRED';

export interface OrderItemView {
  id: string;
  position: number;
  liquidId: string;
  liquidName: string;
  pumpChannel: number;
  requestedMl: number;
  unitPrice: string;
  linePrice: string;
  targetMassG: number | null;
  status: OrderItemStatus;
  /** Live estimate while dispensing (not persisted on every tick). */
  progressMl: number | null;
  deliveredMl: number | null;
  measuredMassG: number | null;
  verification: VerificationLevel | null;
  verificationNote: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface OrderView {
  id: string;
  machineId: string;
  machineName: string;
  status: OrderStatus;
  totalVolumeMl: number;
  totalPrice: string;
  currency: string;
  payment: { mode: PaymentMode; status: PaymentStatus; isTest: boolean };
  cancelRequested: boolean;
  failureReason: string | null;
  /** CREATED orders that are not confirmed by this time are cancelled. */
  expiresAt: string | null;
  items: OrderItemView[];
  createdAt: string;
  updatedAt: string;
}

/** Messages on GET /api/orders/:id/events (Server-Sent Events, `data:` is JSON). */
export type OrderStreamMessage =
  | { type: 'snapshot'; order: OrderView }
  | {
      type: 'progress';
      orderId: string;
      itemId: string;
      progressMl: number | null;
      massG: number | null;
      simulated: boolean;
    };

// ---------------------------------------------------------------- admin

export interface AdminLoginRequest {
  username: string;
  password: string;
}

export interface AdminLoginResponse {
  accessToken: string;
  expiresInSec: number;
}

export interface AdminMachineView {
  id: string;
  publicId: string;
  name: string;
  status: MachineServiceStatus;
  availability: MachineAvailability;
  hardwareConnection: HardwareConnection;
  estopActive: boolean;
  faultReason: string | null;
  activeOrderId: string | null;
  activeCalibrationRunId: string | null;
  lastSeenAt: string | null;
  currency: string;
}

export interface AdminOverview {
  hardwareMode: HardwareMode;
  paymentMode: PaymentMode;
  machines: AdminMachineView[];
}

export interface AdminLiquidView {
  id: string;
  machineId: string;
  name: string;
  imageUrl: string | null;
  pumpChannel: number;
  strategy: DispenseStrategy;
  densityGPerMl: number | null;
  flowRateMlPerSec: number | null;
  cutoffMarginG: number;
  calibratedAt: string | null;
  calibrationSimulated: boolean;
  minMl: number;
  maxMl: number;
  pricePerMl: string;
  active: boolean;
  remainingStockMl: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertLiquidRequest {
  name: string;
  imageUrl?: string | null;
  pumpChannel: number;
  strategy: DispenseStrategy;
  densityGPerMl?: number | null;
  cutoffMarginG?: number;
  minMl: number;
  maxMl: number;
  pricePerMl: string;
  active: boolean;
  remainingStockMl?: number | null;
}

export interface DispensingEventView {
  id: string;
  machineId: string | null;
  orderId: string | null;
  calibrationRunId: string | null;
  type: string;
  severity: 'INFO' | 'WARN' | 'SAFETY';
  pumpChannel: number | null;
  liquidId: string | null;
  payload: unknown;
  actor: string | null;
  createdAt: string;
}

export type CalibrationKind = 'FLOW_RATE' | 'VALIDATION';
export type CalibrationStatus = 'RUNNING' | 'AWAITING_MEASUREMENT' | 'COMPLETED' | 'FAILED';

export interface StartCalibrationRequest {
  liquidId: string;
  kind: CalibrationKind;
  /** FLOW_RATE: fixed pump runtime (bounded by CALIBRATION_MAX_RUNTIME_MS). */
  runtimeMs?: number;
  /** VALIDATION: volume to dispense with the current profile. */
  targetMl?: number;
}

export interface CalibrationMeasurementRequest {
  /** Volume collected in a graduated cylinder. */
  measuredMl: number;
  /** Optional mass of the same sample, used to compute density. */
  measuredMassG?: number;
}

export interface CalibrationRunView {
  id: string;
  liquidId: string;
  liquidName: string;
  pumpChannel: number;
  kind: CalibrationKind;
  status: CalibrationStatus;
  commandedRuntimeMs: number | null;
  actualRuntimeMs: number | null;
  targetMl: number | null;
  measuredMl: number | null;
  measuredMassG: number | null;
  computedDensity: number | null;
  computedFlowRate: number | null;
  previousFlowRate: number | null;
  errorPct: number | null;
  simulated: boolean;
  /** Mock mode only: the simulator's own figure, shown so the operator can enter it. */
  simulatedReadingMl: number | null;
  applied: boolean;
  operator: string;
  failureReason: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface MockFaultConfig {
  /** Multiplies every simulated flow rate (1 = matches calibration). */
  flowRateMultiplier: number;
  /** Per-channel override of the multiplier. */
  channelFlowMultipliers: Record<string, number>;
  /** Channel whose pump fails part-way. */
  failChannel: number | null;
  /** Drop every ACK while commands still execute (simulates a broken uplink). */
  dropAcks: boolean;
  /** Never send DONE (simulates a hung pump step). */
  dropCompletion: boolean;
  /** Disconnect when the given fraction of the current step is reached (0-1). */
  disconnectAtFraction: number | null;
  /** Trigger e-stop when the given fraction of the current step is reached (0-1). */
  estopAtFraction: number | null;
  /** Report unstable scale readings on tare. */
  scaleUnstable: boolean;
  /** Report missing scale (HX711 not responding). */
  scaleMissing: boolean;
}

export interface MockStateView {
  machineId: string;
  connected: boolean;
  estopActive: boolean;
  activeCommandId: string | null;
  config: MockFaultConfig;
}

export interface MachineCredentialView {
  keyId: string;
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

export interface IssuedMachineCredential {
  keyId: string;
  /** Shown once. Flash into the controller's secrets.h. */
  secret: string;
}
