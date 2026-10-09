# PegPal

A QR-based, self-service drink dispensing machine. The machine holds 10 liquid reservoirs, each with its own peristaltic pump. Customers scan a QR code on the machine, pick liquids and quantities on their phone, confirm the order, and watch it dispense in real time. The machine has no touchscreen.

> **Status:** MVP in planning. This README describes the target design and requirements. Setup instructions will be added as each phase lands.

---

## Table of contents

- [Hardware overview](#hardware-overview)
- [Technology stack](#technology-stack)
- [Repository layout (planned)](#repository-layout-planned)
- [Customer experience](#customer-experience)
- [Order state machine](#order-state-machine)
- [Backend modules](#backend-modules)
- [Data model](#data-model)
- [API](#api)
- [Hardware abstraction and protocol](#hardware-abstraction-and-protocol)
- [Dispensing accuracy](#dispensing-accuracy)
- [Calibration](#calibration)
- [Safety](#safety)
- [Security](#security)
- [Admin dashboard](#admin-dashboard)
- [Development roadmap](#development-roadmap)
- [Testing](#testing)
- [Acceptance criteria](#acceptance-criteria)
- [Compliance notice](#compliance-notice)

---

## Hardware overview

| Component | Purpose |
|---|---|
| 10 liquid reservoirs | Ingredient storage |
| 10 peristaltic pumps + motor drivers | One independently controlled pump per liquid |
| ESP32 | Machine controller |
| Load cell + HX711 amplifier | Measures mass added to the glass |
| Dispensing nozzle and glass platform | Output |
| Physical emergency-stop | Cuts motor power locally, independent of software |
| QR code | Opens the customer web app for that machine |

Physical details that aren't known yet (pump flow rates, driver part numbers, load-cell capacity) are exposed as configurable limits behind defined interfaces. None of them are hardcoded.

## Technology stack

**Frontend:** Next.js, TypeScript, React, Tailwind CSS. Mobile-first.

**Backend:** NestJS (TypeScript), REST APIs, WebSocket/SSE for live order status, PostgreSQL, Prisma ORM, strict DTO validation, structured logging, centralized error handling.

**Firmware:** ESP32 on the Arduino framework (via PlatformIO). Arduino has mature HX711 and MQTT/TLS libraries and is quicker to iterate on for an MVP. FreeRTOS is still available underneath for watchdog and task control. We can move to ESP-IDF later if we need finer control.

**Dev/deploy:** Docker Compose (app + PostgreSQL), environment-based configuration, automated tests.

## Repository layout (planned)

```
pegpal/
├── apps/
│   ├── web/            # Next.js customer app + admin dashboard
│   └── api/            # NestJS backend
├── firmware/           # ESP32 firmware (PlatformIO, Arduino framework)
├── packages/
│   └── shared/         # Shared types: order states, protocol messages, DTO contracts
├── docs/               # Architecture, protocol spec, safety & wiring notes
├── docker-compose.yml
└── README.md
```

## Customer experience

1. **Machine landing:** `/machine/:machineId` (e.g. `/machine/MACHINE_001`). The backend validates the machine ID. The page shows the machine name, ID, availability (Available / Busy / Offline / Out of Service), the available liquids, and a **Start Order** button. No admin features are exposed.
2. **Liquid selection:** shows all configured liquids (not hardcoded), each with name, optional image, price per mL, availability, mL quantity selector, and min/max limits. Customers can pick several liquids. The page shows selected items, per-item quantities, total volume, and estimated price, with edit and remove actions. Invalid quantities are rejected on both client and server.
3. **Order review:** shows machine ID, items, total volume, total price, and confirm/cancel actions.
4. **Dispensing progress:** shows order ID, current ingredient, target quantity, progress, completed and remaining ingredients, machine status, and the final success or failure message.

### Payment modes

| Mode | Behavior |
|---|---|
| `TEST_MODE` | Simulated payment or manual developer confirmation. Never presented as a real payment. |
| `PAYMENT_DISABLED` | No payment processing. For controlled internal testing only. |

No real payment provider is integrated until one is explicitly requested. Card details are never stored.

## Order state machine

```
CREATED ──► AUTHORIZED ──► QUEUED ──► DISPENSING ──► COMPLETED
   │            │            │            │
   └────────────┴────────────┴────────────┴──► CANCELLED  (only after hardware confirms stop)
                             │            ├──► FAILED
                             └────────────┴──► SAFETY_STOPPED
```

- Only the transitions shown above are allowed. Any other transition is rejected and logged.
- `COMPLETED`, `FAILED`, `CANCELLED`, and `SAFETY_STOPPED` are terminal.
- An ingredient counts as dispensed only after a hardware acknowledgement **and** completion evidence. Sending the command is not enough.
- If the delivered amount can't be verified, the item is marked **unverified** rather than reported as exact.

## Backend modules

`MachinesModule` · `LiquidsModule` · `OrdersModule` · `DispensingModule` · `HardwareModule` · `AdminModule` · `HealthModule`

## Data model

| Model | Key fields |
|---|---|
| **Machine** | id, name, publicId, status, hardwareConnectionStatus, createdAt, updatedAt |
| **Liquid** | id, name, pumpChannel, densityGPerMl (nullable), calibrationProfile, minMl, maxMl, pricePerMl, active, remainingStockMl, createdAt, updatedAt |
| **Order** | id, machineId, status, totalVolumeMl, totalPrice, idempotencyKey (unique), failureReason, createdAt, updatedAt |
| **OrderItem** | id, orderId, liquidId, requestedMl, targetMassG, measuredMassG, dispensingStatus, verification (`MEASURED` / `ESTIMATED` / `UNVERIFIED`), startedAt, completedAt |
| **DispensingEvent** | id, orderId, type, pumpChannel/liquidId, payload (JSON), timestamp |
| **CalibrationRecord** | id, liquidId, requestedMl, measuredMl, densityGPerMl, computedFlowRate, simulated (bool), operator, createdAt |
| **HardwareCommand** | id (command ID), machineId, orderId, sequence, payload, ackAt, outcome, createdAt |

Machine reservation is atomic: a single active order per machine, enforced at the database level.

## API

| Method | Path | Description |
|---|---|---|
| GET | `/api/machines/:machineId` | Public machine info and availability |
| GET | `/api/machines/:machineId/liquids` | Active liquids with pricing and limits |
| POST | `/api/orders` | Create an order (requires `Idempotency-Key` header) |
| GET | `/api/orders/:orderId` | Order details and status |
| POST | `/api/orders/:orderId/confirm` | Authorize and queue (idempotent) |
| POST | `/api/orders/:orderId/cancel` | Request cancellation (resolves once hardware confirms stop) |
| GET | `/api/orders/:orderId/events` | Live status stream (SSE) |
| GET | `/api/health` | Liveness/readiness |
| * | `/api/admin/...` | Authenticated admin, calibration, and machine control |

The server always does the following:
- Validates that the machine exists and is operational.
- Validates every liquid and quantity.
- Calculates prices itself.
- Enforces safety limits.
- Persists state before any hardware command is sent.
- Handles timeouts and duplicate messages.
- Reconciles state when a controller reconnects.
- Never auto-resumes an interrupted dispense.

## Hardware abstraction and protocol

```ts
interface HardwareAdapter {
  dispense(cmd: DispenseCommand): Promise<CommandAck>;
  stop(machineId: string, reason: string): Promise<CommandAck>;
  tare(machineId: string): Promise<TareResult>;
  getStatus(machineId: string): Promise<MachineHardwareStatus>;
  onEvent(handler: (e: HardwareEvent) => void): void;
}
```

- **`MockHardwareAdapter`** (default): simulates pump start/stop, per-liquid flow rates, progress, completion, sensor readings, pump failures, disconnections, and e-stop events. Flow rates and faults are configurable. Simulated readings are always labeled as simulated.
- **`Esp32HardwareAdapter`**: off by default. Enabled with `HARDWARE_MODE=esp32` once the hardware is configured and tested.

### Transport

MQTT over TLS with per-machine credentials that can be revoked. Each ESP32 subscribes to `pegpal/{machineId}/cmd` and publishes on `pegpal/{machineId}/evt`.

### Messages

```json
// Command (backend → ESP32)
{
  "commandId": "uuid",
  "machineId": "MACHINE_001",
  "orderId": "uuid",
  "seq": 42,
  "type": "DISPENSE",
  "channel": 3,
  "targetMl": 30,
  "targetMassG": 30.6,
  "maxDurationMs": 20000
}

// Event (ESP32 → backend)
{
  "commandId": "uuid",
  "machineId": "MACHINE_001",
  "seq": 42,
  "type": "ACK | PROGRESS | DONE | FAILED | ESTOP",
  "measuredMassG": 30.1,
  "verification": "MEASURED | ESTIMATED | UNVERIFIED",
  "error": null
}
```

- The firmware deduplicates by `commandId`. A retried command never dispenses twice.
- `channel` is a logical index from 0 to 9. Remote clients can never supply GPIO numbers.
- The firmware enforces its own per-channel limits and max runtime, separately from the server.
- On connectivity loss, the firmware stops all pumps locally.
- An uncertain outcome requires reconciliation or operator action. It is never replayed automatically.

## Dispensing accuracy

Running a pump for a fixed time does not reliably deliver a fixed volume. Each liquid has its own viscosity and density, so each one gets its own calibration profile.

**Strategy A: calibrated pump timing**
- Runtime is derived from the liquid's measured flow rate and capped at a maximum.
- Results are reported as **estimated**.

**Strategy B: weight-based (load cell + HX711)**
- Tare the platform only after a stable reading.
- Convert target volume to target mass using density.
- Stop early by a configurable cutoff margin to allow for liquid that keeps flowing after the pump stops.
- Filter readings and detect instability, unexpected weight changes, and sensor faults.

The load cell measures the total mass in the glass. Each ingredient's mass is the delta from the previous stable reading. That is not an independent volume measurement, and the order status and logs say so.

## Calibration

Admin-only UI and API. An operator can:
- Select a liquid or channel and run a bounded test dispense.
- Enter the actual volume collected (graduated cylinder) and the measured density.
- Compute and save a calibrated flow rate.
- Review calibration history and compare requested vs. measured quantities.

In mock mode, calibration data is simulated and labeled as such.

## Safety

This is a physical device, not just a web app.

- Quantity limits on the server **and** independently in firmware.
- Per-pump maximum runtime and maximum order duration.
- Hardware watchdog. Safe boot with all pumps off.
- Pumps shut down on critical faults.
- Interrupted dispenses never restart automatically.
- **The emergency stop is a physical circuit** that cuts motor power. It works without the backend, Wi-Fi, or internet, and software cannot override it.
- Audit logs cover every dispensing command and safety event.

Electrical safety cannot depend on software alone. A wiring and safety document (`docs/safety.md`) will cover the e-stop circuit, motor power isolation, fusing, and electrical protection.

## Security

- Admin authentication. Calibration and machine control require authorization.
- Rate limiting and strict input validation.
- Secrets come from environment variables only. Production secrets are never hardcoded.
- Machine credentials are per-device and can be revoked.
- No unauthenticated pump-control endpoint.
- Idempotency keys and command sequence numbers prevent duplicates and replays.
- Minimal customer data collection.
- The QR code contains only the public machine ID, never credentials.

## Admin dashboard

The dashboard is simple and authenticated. It shows:
- Machine status and current order
- Recent orders
- Liquid configuration and pump mapping
- Calibration profiles
- Dispensing logs
- Error and safety events
- A **MOCK / PHYSICAL** hardware mode indicator

## Development roadmap

1. Inspect the repo and propose the architecture
2. Schema, state machine, API contracts, hardware protocol, safety assumptions
3. Backend and database migrations
4. Mobile-first customer web app
5. Mock hardware and simulated dispensing
6. Live progress, cancellation, idempotency, fault scenarios
7. Admin dashboard and calibration tools
8. ESP32 firmware and real adapter (behind a feature flag)
9. Tests, Docker Compose, documentation

Each phase ends with tests, lint, and type-check passing.

## Testing

Planned automated coverage:
- Quantity, density, and mass conversion
- Calibration and flow-rate calculations
- Duplicate order requests and concurrent orders on one machine
- Invalid state transitions
- Hardware timeouts, emergency stop, and controller disconnection
- Recovery after backend restart
- Failure partway through an order
- Missing or incorrect sensor readings

## Getting started

_Coming in Phase 9._ The target workflow:

```bash
cp .env.example .env          # configure secrets, HARDWARE_MODE=mock, PAYMENT_MODE=TEST_MODE
docker compose up -d          # PostgreSQL + api + web
# open http://localhost:3000/machine/MACHINE_001
```

## Acceptance criteria

1. A customer can open the machine's QR URL on a phone.
2. They can select multiple liquids and quantities.
3. The backend validates and creates the order.
4. Duplicate requests cannot cause duplicate dispensing.
5. The mock controller dispenses the recipe sequentially.
6. The customer sees accurate simulated progress and the final status.
7. A machine cannot accept overlapping active orders.
8. Simulated hardware faults are handled safely.
9. An operator can configure liquids and calibrations.
10. Automated tests cover critical ordering and safety logic.
11. The system starts locally with documented commands.
12. Real hardware integration stays disabled until the hardware is configured and tested.

## Compliance notice

This machine may eventually dispense alcoholic beverages. The software does **not** provide alcohol licensing, age verification, payment compliance, food-contact safety, or operational compliance. Any real deployment needs a review of the local laws and regulations that apply.
