# Controller protocol (v1)

This is the contract between the backend (`apps/api`, `HardwareModule`) and the machine controller (`firmware/`, ESP32). TypeScript definitions live in [`packages/shared/src/protocol.ts`](../packages/shared/src/protocol.ts). If the two disagree, the TypeScript is authoritative.

## Design goals

- **Retries are always safe.** A command can be retransmitted any number of times. It runs at most once.
- **The controller trusts nothing.** The firmware checks every command against its own compile-time limits. The backend's limits are a second, independent layer.
- **No remote GPIO.** Commands name a *logical* pump channel `0..9`. Only the firmware's pin map turns that into a pin.
- **Fail stopped.** Losing the link, rebooting, hitting a watchdog or any fault leaves every pump off. The controller never resumes on its own.
- **Uncertainty is reported, not hidden.** If the outcome of a command is unknown, both sides say so. The backend then needs an operator to reconcile. It never replays the command.

## Transport

**MQTT 3.1.1 over TLS (port 8883)** to a broker such as Mosquitto, which is included as an optional Docker Compose profile.

| Topic | Direction | QoS | Retained | Content |
|---|---|---|---|---|
| `pegpal/v1/{machineId}/cmd` | backend → controller | 1 | no | signed command envelope |
| `pegpal/v1/{machineId}/evt` | controller → backend | 1 | no | signed event envelope |
| `pegpal/v1/{machineId}/online` | controller → backend | 1 | yes | `"1"` on connect; LWT `"0"` |

`machineId` is the machine's public identifier, e.g. `MACHINE_001`.

Authentication has two layers:

1. **Broker credentials.** Each controller has its own MQTT username and password. A broker ACL limits it to its own three topics. The backend has its own broker account.
2. **Application-layer signatures.** Every envelope is signed with a per-machine HMAC key that the backend issues and can revoke (`POST /api/admin/machines/:id/credentials`, `POST /api/admin/credentials/:keyId/revoke`). If the broker were compromised, an attacker still could not inject a valid command or a fake completion.

TLS uses the broker's CA certificate, which is pinned in the firmware (`secrets.h`).

### Simpler alternative

For a single-site pilot, the controller can open an outbound **WSS** connection straight to the backend, using the same signed envelopes. That removes the broker but ties controller connectivity to backend uptime and needs sticky routing if the backend is ever scaled out. The message layer below is identical, so only the adapter's transport changes. MQTT is the default because the broker gives you LWT presence, QoS 1 redelivery, and per-device ACLs without custom code.

## Envelope

```json
{ "keyId": "k_8f2c...", "sig": "<hex hmac-sha256>", "payload": "{\"v\":1,\"type\":\"DISPENSE\",...}" }
```

- `payload` is the message serialized to a JSON **string**.
- `sig = lowercase_hex(HMAC_SHA256(key, utf8(payload)))`, where `key` is the UTF-8 bytes of the provisioned secret string exactly as issued (a 43-character base64url string; do not decode it). The receiver verifies over the exact bytes it received, then parses `payload`. No canonicalization is needed.
- Comparison is constant-time.
- A message with an unknown or revoked `keyId`, or a bad `sig`, is dropped and logged as a security event. The controller sends no ACK for it.

## Commands (backend → controller)

Every command has these fields:

| Field | Type | Notes |
|---|---|---|
| `v` | `1` | protocol version |
| `type` | `DISPENSE` \| `STOP` \| `TARE` \| `STATUS_REQUEST` | |
| `commandId` | string (UUID) | unique; retries reuse it |
| `machineId` | string | must equal the controller's own id |
| `seq` | integer | strictly increasing per machine (persisted in the backend DB) |
| `issuedAt` | epoch ms | |

### `DISPENSE`

| Field | Type | Notes |
|---|---|---|
| `orderId` | string \| null | null for calibration runs |
| `purpose` | `ORDER` \| `CALIBRATION` | |
| `channel` | int `0..9` | logical channel |
| `strategy` | `TIMED` \| `WEIGHT` | |
| `targetMl` | number | for display and limit checks |
| `runtimeMs` | int \| null | TIMED: planned runtime |
| `targetMassG` | number \| null | WEIGHT: target mass gain |
| `cutoffMarginG` | number \| null | WEIGHT: stop at `targetMassG - cutoffMarginG` |
| `maxDurationMs` | int | hard stop |

### `STOP`

`orderId`, `reason`. Switches off every pump immediately and answers with `STOPPED`. It is accepted in any state, including when idle, during e-stop, and with a stale `seq`. Stopping is always safe, so a STOP is never rejected for sequencing reasons. It still has to pass signature verification.

### `TARE`

`orderId`. Waits for a stable reading and zeroes the scale. Answers with `TARE_DONE`.

### `STATUS_REQUEST`

Answers with `STATUS`.

## Events (controller → backend)

Every event has `v`, `type`, `eventId` (unique), `machineId`, `deviceSeq` (increasing, persisted in NVS), `uptimeMs`, and `simulated` (always `false` from real firmware).

| Type | When | Key fields |
|---|---|---|
| `ACK` | command received and validated (or rejected) | `commandId`, `accepted`, `reason?`, `duplicate?` |
| `PROGRESS` | every ~250 ms while a pump runs | `commandId`, `elapsedMs`, `estimatedMl`, `massG` |
| `DONE` | pump step finished normally | `commandId`, `runtimeMs`, `massDeltaG`, `massStable` |
| `FAILED` | pump step aborted | `commandId`, `code`, `message`, `runtimeMs`, `massDeltaG` |
| `STOPPED` | reply to `STOP` | `commandId`, `interruptedCommandId`, `runtimeMs`, `massDeltaG`, `allPumpsOff` |
| `TARE_DONE` | reply to `TARE` | `commandId`, `ok`, `stable`, `platformMassG`, `reason?` |
| `ESTOP` | e-stop pressed, or released and locally reset | `active`, `interruptedCommandId` |
| `FAULT` | fault outside a command (watchdog recovery, scale lost, ...) | `code`, `message`, `interruptedCommandId` |
| `STATUS` | on connect, on `STATUS_REQUEST`, every 10 s | `firmwareVersion`, `estopActive`, `anyPumpOn`, `activeCommandId`, `lastCommandId`, `lastCommandOutcome`, `scaleOk`, `bootedRecently` |

Failure codes: see `FAILURE_CODES` in `protocol.ts`.

## Controller-side validation

The controller rejects a `DISPENSE` (with `ACK accepted=false`) when any of these hold:

- the signature is bad or `machineId` doesn't match (dropped silently, no ACK)
- `channel` is outside `0..9` or not enabled in `ENABLED_CHANNEL_MASK`
- `targetMl > FW_MAX_ML_PER_DISPENSE`
- `maxDurationMs > FW_MAX_PUMP_RUNTIME_MS`
- `runtimeMs > maxDurationMs`
- a dispense is already running (`BUSY`)
- the e-stop is active
- `WEIGHT` is requested but the scale isn't healthy or no successful tare happened for this `orderId` in the last `TARE_VALID_MS`
- `seq <= lastSeq` and `commandId` isn't a known recent command (`STALE_SEQUENCE`)
- the clock is synced and `issuedAt` is older than `COMMAND_MAX_AGE_MS`

The firmware's limits are compile-time constants in `firmware/include/config.h`. No message can change them.

## Idempotency and replay

- The controller keeps a ring buffer of the last 16 `commandId`s with their outcomes.
- **Duplicate of a finished command:** the controller re-sends `ACK duplicate=true` followed by the stored final event. The pump does not run again.
- **Duplicate of a running command:** the controller re-sends `ACK duplicate=true` and nothing else.
- **Retransmission (backend):** if no `ACK` arrives within `ACK_TIMEOUT_MS`, the backend resends the *same* envelope up to `ACK_RETRIES` times. If there's still no ACK, the outcome is **uncertain**. The backend then sends `STOP`, marks the item `UNKNOWN`, fails the order, and puts the machine into `NEEDS_ATTENTION`.
- **Completion timeout:** if `DONE` or `FAILED` doesn't arrive within `maxDurationMs + COMPLETION_GRACE_MS`, the same uncertain-outcome path applies.
- **Event duplicates:** the backend ignores repeated `eventId`s and any `deviceSeq` at or below the last seen value for that key.

## Safety behavior (firmware)

| Situation | Behavior |
|---|---|
| Boot | Every pump output is driven LOW before Wi-Fi starts. The motor-enable relay stays off. If an `inFlight` NVS flag is set, `STATUS.lastCommandOutcome = UNKNOWN`. Nothing resumes. |
| Link loss during a dispense | After `LINK_LOSS_STOP_MS` without the MQTT connection, all pumps stop. The step ends `FAILED code=CONNECTION_LOST`, reported when the link returns. |
| Pump runtime limit | `min(maxDurationMs, FW_MAX_PUMP_RUNTIME_MS)` is enforced from a hardware timer. |
| Watchdog | Task watchdog (`WDT_TIMEOUT_S`). A hang resets the chip, then the safe boot above runs. |
| E-stop | A physical NC switch breaks motor power directly (see `docs/safety.md`). A second contact goes to a GPIO interrupt that latches `ESTOP`, drives outputs LOW, and emits `ESTOP active=true`. Clearing it requires the physical switch to be released **and** the local reset button. No remote message can clear it. |
| Scale faults | If HX711 isn't ready for longer than `SCALE_TIMEOUT_MS`, the result is `SCALE_FAULT`. A mass drop greater than `MASS_DROP_FAULT_G` (glass removed) or a gain faster than `MAX_PLAUSIBLE_FLOW_G_PER_S` gives `UNEXPECTED_MASS_CHANGE`. No gain after `NO_FLOW_TIMEOUT_MS` gives `NO_FLOW_DETECTED`. Every one of these stops the pump. |

## Sequence: one order

```
backend                                   controller
   | TARE (if any item uses WEIGHT or a scale is fitted)
   |---------------------------------------->|
   |<------------------------------ ACK      |
   |<------------------------------ TARE_DONE|
   | DISPENSE item 1 (persisted first)       |
   |---------------------------------------->|
   |<------------------------------ ACK      |
   |<--------------------------- PROGRESS ...|
   |<------------------------------ DONE     |
   | DISPENSE item 2 ...                     |
   | (cancel requested)  STOP                |
   |---------------------------------------->|
   |<------------------------------ STOPPED  |
```

## Measurement semantics

There is one load cell, and it measures the total mass in the glass. For each step, `massDeltaG` is the difference between the stable readings just before and just after that step. The backend converts it to volume with the liquid's configured density and labels it `MASS_DELTA`. That is an inference, not an independent volume measurement. If the readings were unstable, the density is unknown, or the delta is implausible, the item is reported as `ESTIMATED` (from runtime and flow rate) or `UNVERIFIED`.

## Firmware implementation notes (v1)

### ACK rejection reasons

These come from `firmware/src/commands.cpp`. The backend treats every rejection the same way: the pump did not start, so the outcome is certain and the item becomes `FAILED`.

| Condition | `reason` |
|---|---|
| clock not SNTP-synced (DISPENSE requires it), channel outside 0..9, WEIGHT without a valid tare for this order, malformed fields | `INVALID_COMMAND` |
| channel not in `ENABLED_CHANNEL_MASK` | `CHANNEL_DISABLED` |
| volume, runtime or mass above firmware limits (a WEIGHT target may not exceed `FW_MAX_ML_PER_DISPENSE × 1.5 g/mL`) | `LIMIT_EXCEEDED` |
| `seq` not newer than the last one, or `issuedAt` too old or more than 5 s in the future | `STALE_SEQUENCE` |
| another dispense is running | `BUSY` |
| e-stop latched | `ESTOP` |
| WEIGHT requested with an unhealthy scale | `SCALE_FAULT` |

`NO_GLASS` arrives as a `FAILED` event after an accepted ACK. It is only checked once an empty-platform baseline has been calibrated.

### Other behaviour

- **Every command is ACKed before its reply event**, including STOP.
- **A duplicate commandId** gets the stored final event re-sent, with a new `eventId` and `deviceSeq`, so the backend's replay guard accepts it.
- **QoS levels.** Important events are QoS 1. They are queued while offline and flushed on reconnect, which is how `FAILED code=CONNECTION_LOST` reaches the backend. PROGRESS is QoS 0 and is dropped while offline.
- **`deviceSeq`** is saved to NVS every 1000 events and skips ahead after a reboot to stay monotonic.
- **Boot FAULTs.** A `FAULT code=WATCHDOG` is sent after a watchdog or panic reset. A brownout during a dispense shows only as `STATUS.lastCommandOutcome=UNKNOWN`.

### Known limitations

These must be resolved before real use. All three come from network I/O sharing the main loop.

1. **A QoS 1 publish while pumping can block the loop** for up to one broker round trip (at most about 1 s). A WEIGHT cutoff can be late by that much, so `cutoffMarginG` must cover it. The hardware-timer runtime cap and the e-stop ISR are not affected.
2. **A silently dead TCP session** (Wi-Fi still up) is only detected after about 1.5 × the 10 s MQTT keepalive. During that time the pump keeps running, but never past the runtime cap. The backend notices sooner because PROGRESS stops arriving, and it then treats the outcome as uncertain.
3. **No reconnect is attempted while a pump is running.**

The planned fix is to move network I/O into its own FreeRTOS task and add an application-level heartbeat with a short timeout.
