# Architecture

## 1. System context

```
 ┌──────────────┐  scan QR   ┌───────────────────────┐  /api/* (rewrite)  ┌─────────────────────────┐
 │ Customer     │ ─────────► │ apps/web  (Next.js)   │ ─────────────────► │ apps/api  (NestJS)       │
 │ phone        │ ◄───────── │ customer + admin UI   │ ◄── SSE ────────── │ REST + SSE + safety core │
 └──────────────┘            └───────────────────────┘                    └──────┬─────────┬────────┘
                                                                                 │         │
 ┌──────────────┐  same web app, /admin (JWT)                                    │ Prisma  │ HardwareAdapter
 │ Operator     │ ──────────────────────────────────────────────────────────►    ▼         ▼
 └──────────────┘                                                        ┌────────────┐ ┌──────────────────────┐
                                                                         │ PostgreSQL │ │ Mock (in-process) or │
                                                                         └────────────┘ │ ESP32 via MQTT/TLS   │
                                                                                        └──────────┬───────────┘
                                                                                                   ▼
                                                                         ESP32 firmware ─ pumps ×10, HX711, e-stop
```

- **One public URL per machine:** `https://<host>/machine/<PUBLIC_ID>`. The QR code contains only the public id and no credentials.
- **Same origin:** the web app proxies `/api/*` to the API, so the browser talks to a single origin. That avoids CORS and keeps SSE straightforward.
- **The firmware is the last line of software safety.** The physical e-stop circuit sits beneath all software (see [safety.md](safety.md)).

## 2. Repository layout

```
pegpal/
├── apps/
│   ├── api/                 NestJS backend
│   │   ├── prisma/          schema, migrations, seed
│   │   ├── src/
│   │   │   ├── machines/    MachinesModule – public machine view, availability
│   │   │   ├── liquids/     LiquidsModule – public list, admin CRUD, DTOs
│   │   │   ├── orders/      OrdersModule – create/confirm/cancel, idempotency, SSE, expiry
│   │   │   ├── dispensing/  DispensingModule – order runner, plan, evidence, restart recovery
│   │   │   ├── hardware/    HardwareModule – adapter interface, mock + ESP32 adapters, ControllerService, credentials
│   │   │   ├── admin/       AdminModule – auth, dashboard APIs, calibration, simulator controls
│   │   │   ├── health/      HealthModule
│   │   │   ├── audit/       append-only audit log (DispensingEvent)
│   │   │   ├── common/      errors, exception filter, request id, params
│   │   │   └── config/      zod-validated environment config
│   │   └── test/            integration tests (real Postgres + simulator)
│   └── web/                 Next.js app (customer flow + /admin)
├── packages/shared/         types + pure logic shared by api and web (state machine, units, protocol)
├── firmware/                ESP32 firmware (PlatformIO, Arduino framework)
├── infra/                   Postgres init, Mosquitto config
└── docs/                    you are here
```

## 3. Backend modules

| Module | Responsibility | Key files |
|---|---|---|
| `MachinesModule` | Look up machines by public id; derive customer availability | `machines.service.ts`, `availability.ts` |
| `LiquidsModule` | Public liquid list; admin create/update; dispensability rules | `liquids.service.ts`, `liquid.dto.ts` |
| `OrdersModule` | Validation, server-side pricing, idempotent create, atomic reservation, confirm/cancel, expiry, SSE | `orders.service.ts`, `orders.repository.ts`, `order-stream.service.ts` |
| `DispensingModule` | Runs confirmed orders step by step; turns controller reports into evidence; closes out interrupted work on boot | `dispensing.service.ts`, `plan.ts`, `evidence.ts`, `recovery.service.ts` |
| `HardwareModule` | Transport abstraction; command persistence, sequencing, retransmission, event ingestion, reconciliation; machine credentials | `controller.service.ts`, `mock/*`, `esp32/*`, `credentials.service.ts` |
| `AdminModule` | Operator login (JWT), overview, logs, machine control, calibration, simulator controls | `admin.controller.ts`, `admin.service.ts`, `calibration.service.ts` |
| `HealthModule` | Liveness and DB check | `health.controller.ts` |

`OrderStoreModule` (global) holds the order repository, view builder and stream so that Orders, Dispensing and Admin can share them without circular imports.

## 4. Order lifecycle at runtime

```
POST /orders ──► validate + price ──► tx{ create order, reserve machine } ──► CREATED
POST /confirm ─► payment (TEST_MODE / PAYMENT_DISABLED) ──► AUTHORIZED ──► QUEUED ──► DispensingService.start()

DispensingService (one runner per order, sequential):
  preflight (in service? e-stop? connected?) ─► plan all items (calibration → runtime / target mass, bounded)
  QUEUED→DISPENSING ─► [TARE if any WEIGHT item or SCALE_FITTED]
  for each item:
     persist item DISPENSING ─► ControllerService.issue(DISPENSE)  (seq allocated + row written first)
     ControllerService.deliver()  (send, await ACK, retransmit identical command)
     await DONE | FAILED | STOPPED(interrupted) | ESTOP | timeout | disconnect
     evaluateEvidence() ─► item COMPLETED/FAILED/STOPPED/UNKNOWN with verification level
  terminal transition releases the machine (and locks it as NEEDS_ATTENTION when the outcome is uncertain)
```

The full transition table is in [state-machine.md](state-machine.md).

## 5. Design decisions

| Decision | Why |
|---|---|
| **One owner of pump commands per order (the runner).** Cancel only sets a flag and sends a signal. | Two writers racing on the pump is the classic way to lose a STOP. The runner sends STOP itself and is the only code that can mark an order CANCELLED. |
| **Persist before send.** | After a crash the database always knows which command may have run. |
| **Conditional `UPDATE … WHERE status IN (…)` for every transition.** | Illegal or racing transitions fail by construction, with no application-level locks. |
| **Reservation column + partial unique index.** | The first is the fast path. The second is a database-enforced backstop. |
| **Retransmit the identical command; never re-issue.** | The controller deduplicates on `commandId`, so a retry can't cause a second dispense. |
| **Uncertain ⇒ STOP + UNKNOWN + NEEDS_ATTENTION.** | We never guess at physical outcomes and never auto-retry a dispense. |
| **Evidence levels (`SIMULATED` / `ESTIMATED` / `MASS_DELTA` / `UNVERIFIED`).** | The UI and logs say exactly how much we know. One load cell can't independently measure each ingredient. |
| **Mock adapter mirrors firmware rules.** | Tests exercise the same validation, deduplication and safe-stop paths that the real controller enforces. |
| **Arduino framework for firmware.** | Mature HX711, MQTT and TLS libraries and quicker iteration. FreeRTOS and the task watchdog are still available. See `firmware/README.md`. |
| **MQTT over TLS + application-layer HMAC.** | Broker ACLs give per-device isolation. HMAC keys are revocable in the backend and survive a broker compromise. |
| **Order-token header for confirm/cancel.** | Anyone can view an order by its UUID, but only the phone that created it can drive it. The token is derived with HMAC, so no extra secret is stored. |

## 6. Assumptions and limits

- **Single backend instance.** The SSE bus, the order runners and event waiters live in process memory. Scaling out needs a shared bus (for example Postgres `LISTEN/NOTIFY` or Redis) and machine-affinity for runners. The database-level guards already prevent double reservation.
- **One active order per machine** (an MVP requirement).
- **No real payment provider.** `TEST_MODE` and `PAYMENT_DISABLED` are both non-production. The API refuses to start in `NODE_ENV=production` without an explicit `ALLOW_UNPAID_DISPENSING=true`.
- **Physical hardware details are unknown.** Pin maps, flow rates and load-cell capacity are configuration, not facts. See [safety.md](safety.md) and `firmware/include/config.h`.
