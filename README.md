# PegPal

**A QR-ordered, self-service drink dispensing machine.** It has ten liquids and ten pumps, an ESP32 controller and a load cell, and no touchscreen. Customers scan a QR code, choose liquids and quantities on their phone, confirm, and watch it pour live.

This repository holds a working MVP: a NestJS backend, a mobile-first Next.js web app, ESP32 firmware, and a **hardware simulator**. With the simulator, the whole system runs and can be tested without the physical machine.

> **Status: MVP, mock hardware.** Everything runs end to end against the simulator. The ESP32 adapter and firmware are implemented behind an explicit feature flag but have **not been tested on physical hardware**. Read [Safety](docs/safety.md) before connecting pumps.

---

## Contents

1. [Features](#features)
2. [Quick start](#quick-start)
3. [How it works](#how-it-works)
4. [Repository layout](#repository-layout)
5. [Documentation](#documentation)
6. [Development](#development)
7. [Acceptance criteria](#acceptance-criteria)
8. [Safety and compliance](#safety-and-compliance)

---

## Features

### For customers

- **Machine page** (`/machine/<ID>`) shows the machine's availability (Available, Busy, Offline or Out of Service) and the configured liquids.
- **Choose several liquids** with mL steppers. The client checks each liquid's min and max, the order's total volume limit and the item count, and shows an estimated price.
- **Order review** shows the price calculated by the server, with confirm and cancel buttons and a clear test-mode payment banner.
- **Live progress** over Server-Sent Events, falling back to polling. It shows the current ingredient, its progress, what's done and what's left, and an honest verification label for every item.

### Safety core

- A strict state machine. Every transition is a single guarded SQL update.
- **Idempotent** order creation and confirmation. Retries never cause a second dispense.
- **One active order per machine.** The machine is reserved atomically, and a partial unique index backs that up in the database.
- **Persist before send.** Every controller command gets its sequence number and is written to the database before it's transmitted.
- **Uncertain outcomes are never guessed or retried.** The backend sends STOP, marks the item `UNKNOWN`, and locks the machine for an operator.
- Cancelling is only treated as successful once the controller has confirmed every pump is off.
- After a restart, nothing resumes on its own.
- Limits apply on the server *and* separately in the firmware. Commands use logical channels only, never GPIO numbers.

### Hardware

- **`MockHardwareAdapter`** simulates flow rates that differ per channel, progress reports, pump faults, lost ACKs, hung steps, disconnects, the e-stop, and unstable or missing scales. Every figure it reports is labelled simulated.
- **`Esp32HardwareAdapter`** talks MQTT over TLS, with per-machine HMAC keys that can be revoked and replay protection.
- **ESP32 firmware** (Arduino framework) has these protections:
  - safe boot with every pump off
  - an e-stop latch that can only be cleared locally
  - a watchdog
  - a local stop when the network link is lost
  - HX711 tare, filtering, stability and fault detection

### Dispensing accuracy

- Each liquid has its own calibration profile.
- There are two strategies: **timed** (a calibrated flow rate) and **weight-based** (load cell, density and a cutoff margin).
- Every delivered quantity is labelled with how it was verified:

| Label | Meaning |
|---|---|
| `SIMULATED` | produced by the mock; no physical measurement |
| `ESTIMATED` | worked out from pump runtime and the calibrated flow rate |
| `MASS_DELTA` | inferred from the change in total glass mass, using the configured density |
| `UNVERIFIED` | no trustworthy evidence |

### Operators (`/admin`)

- Machine status, the current order, recent orders, and safety and error events.
- A badge showing whether the hardware is MOCK or PHYSICAL.
- Liquid configuration and pump-to-liquid mapping.
- Calibration: run a bounded test dispense, enter the measured volume and mass, compute the flow rate and density, apply it, and review history and validation error.
- A simulator fault panel in mock mode.
- Software stop of all pumps, and clearing a fault once a fresh status has been checked.
- Issuing and revoking machine credentials.

## Quick start

Prerequisites: **Bun 1.4**, **Node 22**, **Docker**.

```bash
bun install
bun run db:up                                   # Postgres on :5433
cp apps/api/.env.example apps/api/.env          # then: MACHINE_SECRET_ENCRYPTION_KEY=$(openssl rand -base64 32)
bun run build:shared
bun run --cwd apps/api prisma:generate
bun run db:migrate && bun run db:seed
bun run dev:api                                 # terminal 1 → http://localhost:3001/api/health
bun run dev:web                                 # terminal 2 → http://localhost:3000
```

| Open | |
|---|---|
| http://localhost:3000/machine/MACHINE_001 | customer flow (what the QR code links to) |
| http://localhost:3000/admin | operator dashboard. Log in as `operator` / `pegpal-dev-password` (dev only). |

To run the full stack in Docker, use `docker compose --profile app up --build`. More options are in [Getting started](docs/getting-started.md).

## How it works

```
Phone ──QR──► Next.js (/machine/ID) ──/api──► NestJS ──► PostgreSQL
                    ▲                            │
                    └──────── SSE progress ──────┤
                                                 ▼
                                   HardwareAdapter: Mock | ESP32 (MQTT/TLS, HMAC)
                                                 ▼
                                   ESP32 ─► 10 pumps · HX711 load cell · e-stop
```

An order moves through these states:

```
CREATED ─confirm─► AUTHORIZED ─► QUEUED ─► DISPENSING ─► COMPLETED
   └─cancel/expire─► CANCELLED      └─► FAILED · CANCELLED (after a confirmed stop) · SAFETY_STOPPED
```

[Architecture](docs/architecture.md) and the [state machine](docs/state-machine.md) explain the details.

## Repository layout

| Path | What |
|---|---|
| `apps/api` | NestJS backend: Machines, Liquids, Orders, Dispensing, Hardware, Admin and Health modules, plus the Prisma schema, migrations, seed and tests |
| `apps/web` | Next.js 15 + Tailwind 4 customer and operator UI |
| `packages/shared` | state machine, unit and calibration math, protocol and API types shared by the API and the web app |
| `firmware` | ESP32 firmware (PlatformIO, Arduino framework) |
| `infra` | Postgres init, Mosquitto TLS and ACL config |
| `docs` | documentation (below) |

## Documentation

| | |
|---|---|
| [Getting started](docs/getting-started.md) | setup, configuration, troubleshooting |
| [Architecture](docs/architecture.md) | components, modules, runtime flow, design decisions |
| [State machine](docs/state-machine.md) | statuses, legal transitions, recovery |
| [HTTP API](docs/api.md) | endpoints, errors, idempotency, SSE |
| [Data model](docs/data-model.md) | tables and constraints |
| [Controller protocol](docs/hardware-protocol.md) | MQTT topics, signed envelopes, commands and events, retry and replay rules |
| [Dispensing & calibration](docs/dispensing-and-calibration.md) | accuracy, evidence levels, calibration procedure |
| [Safety](docs/safety.md) | e-stop circuit, motor power, fusing, compliance |
| [Security](docs/security.md) | threat model, controls, production checklist |
| [Operations](docs/operations.md) | runbook for faults, e-stops, restarts and credentials |
| [Testing](docs/testing.md) | how to run the tests, with a map from requirements to tests |
| [Firmware](firmware/README.md) | build, flash, provision, bench test |

## Development

| Command | |
|---|---|
| `bun run test` | all tests: shared, API unit and integration, web |
| `bun run lint` · `bun run typecheck` | every workspace |
| `bun run --cwd apps/api test:integration` | API integration tests on real Postgres with the simulator (needs `bun run db:up`) |
| `bun run --cwd apps/api hash-password '<pw>'` | generate `ADMIN_PASSWORD_HASH` |

The stack is TypeScript throughout: NestJS 11, Prisma 6, PostgreSQL 16, Next.js 15, React 19, Tailwind 4 and Jest. Bun manages packages and Node 22 is the runtime.

## Acceptance criteria

| # | Criterion | Status |
|---|---|---|
| 1 | Customer opens the QR URL on a phone | ✅ `/machine/[id]`, checked at 360 px with no horizontal overflow |
| 2 | Selects several liquids and quantities | ✅ |
| 3 | Backend validates and creates the order | ✅ strict DTOs, per-liquid and per-order limits, server-side pricing |
| 4 | Duplicate requests can't cause a duplicate dispense | ✅ idempotency key, idempotent confirm, controller deduplication. Tested. |
| 5 | Mock controller runs the recipe in sequence | ✅ tested |
| 6 | Customer sees simulated progress and the final status | ✅ SSE through the web proxy |
| 7 | No overlapping active orders | ✅ atomic reservation and partial unique index. Tested with concurrent requests. |
| 8 | Simulated faults handled safely | ✅ pump fault, lost ACK, missing completion, disconnect, e-stop and scale faults are all tested |
| 9 | Operator configures liquids and calibration | ✅ admin UI and API. Tested. |
| 10 | Automated tests cover ordering and safety logic | ✅ 172 tests ([map](docs/testing.md)) |
| 11 | Starts locally with documented commands | ✅ [Getting started](docs/getting-started.md) |
| 12 | Real hardware stays disabled until configured | ✅ needs `HARDWARE_MODE=esp32`, `ENABLE_ESP32_ADAPTER=true` and `mqtts://` |

## Safety and compliance

This software controls a **physical** device. The software limits are a second layer of protection; they don't replace the physical safety design. These are required:

- a hard-wired emergency stop that cuts motor power
- motor power kept separate from the logic supply, with fusing
- pump drivers that hold the pumps off while the controller is booting or resetting

[docs/safety.md](docs/safety.md) covers all of this.

The machine may eventually dispense alcohol. **The software doesn't make a deployment compliant with alcohol licensing, age verification, payment, food-contact or electrical-safety rules.** Each deployment needs its own review against local law. `TEST_MODE` and `PAYMENT_DISABLED` take no real payment, and the API refuses to start in production in either mode without an explicit override.
