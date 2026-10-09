/**
 * Backend <-> controller protocol, version 1. Normative spec: docs/hardware-protocol.md.
 *
 * Every message is a JSON envelope. Commands flow backend -> controller,
 * events flow controller -> backend. Over the network each envelope is signed
 * (HMAC-SHA256 with the machine's credential); the mock adapter skips signing
 * because it never leaves the process.
 */

export const PROTOCOL_VERSION = 1;

/** Logical pump channels. Never GPIO numbers: the firmware owns the pin map. */
export const PUMP_CHANNEL_COUNT = 10;

export type DispenseStrategy = 'TIMED' | 'WEIGHT';

interface CommandBase {
  v: typeof PROTOCOL_VERSION;
  /** Unique per command. Retries reuse the same id; the controller deduplicates on it. */
  commandId: string;
  machineId: string;
  /** Strictly increasing per machine. Stale sequence numbers are rejected unless the commandId is a known retry. */
  seq: number;
  /** Epoch ms when the backend issued the command. */
  issuedAt: number;
}

export interface DispenseCommand extends CommandBase {
  type: 'DISPENSE';
  orderId: string | null;
  /** Calibration runs are not linked to customer orders. */
  purpose: 'ORDER' | 'CALIBRATION';
  channel: number;
  strategy: DispenseStrategy;
  targetMl: number;
  /** TIMED: planned runtime from the calibration profile. */
  runtimeMs: number | null;
  /** WEIGHT: stop when the glass gains (targetMassG - cutoffMarginG). */
  targetMassG: number | null;
  cutoffMarginG: number | null;
  /** Hard upper bound; the controller also applies its own compile-time cap. */
  maxDurationMs: number;
}

export interface StopCommand extends CommandBase {
  type: 'STOP';
  orderId: string | null;
  reason: string;
}

export interface TareCommand extends CommandBase {
  type: 'TARE';
  orderId: string | null;
}

export interface StatusRequestCommand extends CommandBase {
  type: 'STATUS_REQUEST';
}

export type ControllerCommand = DispenseCommand | StopCommand | TareCommand | StatusRequestCommand;
export type ControllerCommandType = ControllerCommand['type'];

interface EventBase {
  v: typeof PROTOCOL_VERSION;
  /** Unique per event, used for duplicate suppression. */
  eventId: string;
  machineId: string;
  /** Controller-side monotonic counter (resets only on credential change). */
  deviceSeq: number;
  /** Controller uptime when the event was produced. */
  uptimeMs: number;
  /** True when the event comes from the mock controller and carries no real measurements. */
  simulated: boolean;
}

export interface AckEvent extends EventBase {
  type: 'ACK';
  commandId: string;
  accepted: boolean;
  /** Present when accepted === false. */
  reason?: string;
  /** True when this ACK answers a retried commandId the controller already knew. */
  duplicate?: boolean;
}

export interface ProgressEvent extends EventBase {
  type: 'PROGRESS';
  commandId: string;
  elapsedMs: number;
  /** TIMED strategy: estimate from runtime x flow rate. */
  estimatedMl: number | null;
  /** WEIGHT strategy: mass gained since tare. */
  massG: number | null;
}

export interface DoneEvent extends EventBase {
  type: 'DONE';
  commandId: string;
  runtimeMs: number;
  /** Mass gained between stable readings before and after this pump step. */
  massDeltaG: number | null;
  /** Mass reading was stable at the end of the step. */
  massStable: boolean | null;
}

export interface FailedEvent extends EventBase {
  type: 'FAILED';
  commandId: string;
  code: FailureCode;
  message: string;
  /** How long the pump actually ran before it was switched off. */
  runtimeMs: number | null;
  massDeltaG: number | null;
}

export interface StoppedEvent extends EventBase {
  type: 'STOPPED';
  /** The STOP command being acknowledged. */
  commandId: string;
  /** The dispense command that was interrupted, if any. */
  interruptedCommandId: string | null;
  runtimeMs: number | null;
  massDeltaG: number | null;
  /** All pump outputs are confirmed off. */
  allPumpsOff: boolean;
}

export interface TareDoneEvent extends EventBase {
  type: 'TARE_DONE';
  commandId: string;
  ok: boolean;
  stable: boolean;
  /** Mass on the platform relative to the empty-platform baseline (detects a glass). */
  platformMassG: number | null;
  reason?: string;
}

export interface EstopEvent extends EventBase {
  type: 'ESTOP';
  /** true = pressed/latched, false = released and reset locally. */
  active: boolean;
  interruptedCommandId: string | null;
}

export interface StatusEvent extends EventBase {
  type: 'STATUS';
  firmwareVersion: string;
  estopActive: boolean;
  anyPumpOn: boolean;
  activeCommandId: string | null;
  lastCommandId: string | null;
  lastCommandOutcome: 'DONE' | 'FAILED' | 'STOPPED' | 'NONE' | 'UNKNOWN';
  scaleOk: boolean;
  /** Set after a reboot; cleared once the backend has seen a STATUS. */
  bootedRecently: boolean;
}

export interface FaultEvent extends EventBase {
  type: 'FAULT';
  code: FailureCode;
  message: string;
  /** Command interrupted by the fault, if any. Pumps are always off after a FAULT. */
  interruptedCommandId: string | null;
}

/** Synthesized by adapters, never sent by firmware. */
export interface ConnectionEvent {
  type: 'CONNECTION';
  machineId: string;
  connected: boolean;
  reason?: string;
}

export type ControllerEvent =
  | AckEvent
  | ProgressEvent
  | DoneEvent
  | FailedEvent
  | StoppedEvent
  | TareDoneEvent
  | EstopEvent
  | StatusEvent
  | FaultEvent;

export type HardwareEvent = ControllerEvent | ConnectionEvent;

export const FAILURE_CODES = [
  'INVALID_COMMAND',
  'CHANNEL_DISABLED',
  'LIMIT_EXCEEDED',
  'BUSY',
  'STALE_SEQUENCE',
  'MAX_DURATION_EXCEEDED',
  'NO_FLOW_DETECTED',
  'SCALE_FAULT',
  'SCALE_UNSTABLE',
  'UNEXPECTED_MASS_CHANGE',
  'NO_GLASS',
  'PUMP_FAULT',
  'ESTOP',
  'CONNECTION_LOST',
  'WATCHDOG',
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

/** Messages with these types carry a commandId that refers to a backend command. */
export function eventCommandId(event: HardwareEvent): string | null {
  return 'commandId' in event ? event.commandId : null;
}

/**
 * Wire wrapper. The sender serializes the message to a JSON string once and
 * signs those exact bytes, so no cross-language canonicalization is needed:
 * `sig` = lowercase hex HMAC-SHA256(secret, utf8(payload)).
 */
export interface SignedEnvelope {
  keyId: string;
  sig: string;
  payload: string;
}
