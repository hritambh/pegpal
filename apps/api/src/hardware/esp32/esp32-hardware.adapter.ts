import { Logger } from '@nestjs/common';
import type { ControllerCommand, ControllerEvent, HardwareEvent } from '@pegpal/shared';
import { PROTOCOL_VERSION } from '@pegpal/shared';
import { readFileSync } from 'node:fs';
import mqtt, { MqttClient } from 'mqtt';
import type { AuditService } from '../../audit/audit.service';
import type { CredentialsService } from '../credentials.service';
import type { HardwareAdapter } from '../hardware-adapter';
import { parseEnvelope, seal } from './envelope';

export interface Esp32AdapterOptions {
  url: string;
  username?: string;
  password?: string;
  caFile?: string;
  heartbeatTimeoutMs: number;
}

const topic = (machineId: string, leaf: 'cmd' | 'evt' | 'online') => `pegpal/v1/${machineId}/${leaf}`;
const EVENT_TYPES = new Set(['ACK', 'PROGRESS', 'DONE', 'FAILED', 'STOPPED', 'TARE_DONE', 'ESTOP', 'STATUS', 'FAULT']);

/**
 * MQTT-over-TLS transport to ESP32 controllers (docs/hardware-protocol.md).
 * Only enabled with HARDWARE_MODE=esp32 AND ENABLE_ESP32_ADAPTER=true.
 * NOTE: not yet validated against physical hardware.
 */
export class Esp32HardwareAdapter implements HardwareAdapter {
  readonly mode = 'esp32' as const;
  readonly timeScale = 1;
  private readonly logger = new Logger('Esp32Hardware');
  private client: MqttClient | null = null;
  private readonly machines = new Set<string>();
  private readonly online = new Map<string, boolean>();
  private readonly lastHeard = new Map<string, number>();
  private readonly listeners = new Set<(e: HardwareEvent) => void>();
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly opts: Esp32AdapterOptions,
    private readonly credentials: CredentialsService,
    private readonly audit: AuditService,
  ) {}

  private connect(): MqttClient {
    if (this.client) return this.client;
    const client = mqtt.connect(this.opts.url, {
      username: this.opts.username,
      password: this.opts.password,
      ca: this.opts.caFile ? readFileSync(this.opts.caFile) : undefined,
      rejectUnauthorized: true,
      clean: true,
      reconnectPeriod: 2000,
    });
    client.on('connect', () => {
      this.logger.log({ msg: 'Connected to MQTT broker' });
      for (const id of this.machines) this.subscribe(id);
    });
    client.on('error', (err) => this.logger.error({ msg: 'MQTT error', err: err.message }));
    client.on('message', (t, payload) => void this.onMessage(t, payload));
    this.heartbeatTimer = setInterval(() => this.checkHeartbeats(), 1000);
    this.client = client;
    return client;
  }

  async register(machineId: string): Promise<void> {
    this.machines.add(machineId);
    const client = this.connect();
    if (client.connected) this.subscribe(machineId);
  }

  async send(command: ControllerCommand): Promise<void> {
    const key = await this.credentials.signingKeyFor(command.machineId);
    if (!key) {
      this.logger.error({ msg: 'No active credential; command not sent', machineId: command.machineId, commandId: command.commandId });
      return;
    }
    const envelope = seal(key.keyId, key.secret, command);
    await this.client?.publishAsync(topic(command.machineId, 'cmd'), JSON.stringify(envelope), { qos: 1 });
  }

  isConnected(machineId: string): boolean {
    return (this.client?.connected ?? false) && this.online.get(machineId) === true;
  }

  onEvent(listener: (event: HardwareEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async shutdown(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    await this.client?.endAsync();
    this.client = null;
  }

  private subscribe(machineId: string): void {
    this.client?.subscribe([topic(machineId, 'evt'), topic(machineId, 'online')], { qos: 1 });
  }

  private async onMessage(t: string, raw: Buffer): Promise<void> {
    const [, , machineId, leaf] = t.split('/');
    if (!machineId || !this.machines.has(machineId)) return;

    if (leaf === 'online') {
      // Presence only; it carries no commands and cannot affect dispensing state by itself.
      this.setOnline(machineId, raw.toString() === '1', 'presence topic');
      return;
    }
    if (leaf !== 'evt') return;

    const envelope = parseEnvelope(raw);
    if (!envelope) return this.reject(machineId, 'malformed envelope');
    let event: ControllerEvent;
    try {
      event = JSON.parse(envelope.payload) as ControllerEvent;
    } catch {
      return this.reject(machineId, 'unparseable payload');
    }
    if (event.v !== PROTOCOL_VERSION || event.machineId !== machineId || !EVENT_TYPES.has(event.type)) {
      return this.reject(machineId, 'invalid event header');
    }
    const check = await this.credentials.verifyIncoming(envelope, machineId, () =>
      Number.isInteger(event.deviceSeq) ? event.deviceSeq : null,
    );
    if (!check.ok) return this.reject(machineId, check.reason);
    // Real firmware never reports simulated data.
    event.simulated = false;
    this.lastHeard.set(machineId, Date.now());
    this.setOnline(machineId, true, 'event received');
    this.dispatch(event);
  }

  private reject(machineId: string, reason: string): void {
    this.logger.warn({ msg: 'Rejected controller message', machineId, reason });
    void this.audit.record({ type: 'CONTROLLER_MESSAGE_REJECTED', severity: 'WARN', payload: { machinePublicId: machineId, reason } });
  }

  private checkHeartbeats(): void {
    const now = Date.now();
    for (const id of this.machines) {
      const heard = this.lastHeard.get(id) ?? 0;
      if (this.online.get(id) && now - heard > this.opts.heartbeatTimeoutMs) this.setOnline(id, false, 'heartbeat timeout');
    }
  }

  private setOnline(machineId: string, connected: boolean, reason: string): void {
    if (this.online.get(machineId) === connected) return;
    this.online.set(machineId, connected);
    if (connected) this.lastHeard.set(machineId, Date.now());
    this.dispatch({ type: 'CONNECTION', machineId, connected, reason });
  }

  private dispatch(event: HardwareEvent): void {
    for (const l of this.listeners) l(event);
  }
}
