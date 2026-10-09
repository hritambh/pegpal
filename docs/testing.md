# Testing

## Layers

| Layer | Runner | Needs | Location |
|---|---|---|---|
| Shared domain logic | Jest | nothing | `packages/shared/src/*.test.ts` |
| API unit | Jest (`unit` project) | nothing | `apps/api/src/**/*.spec.ts` |
| API integration | Jest (`integration` project) | Postgres (`bun run db:up`) | `apps/api/test/*.e2e-spec.ts` |
| Web logic | Jest | nothing | `apps/web/src/lib/*.test.ts` |
| Firmware | compile check | PlatformIO | `firmware/` (see its README) |

The integration tests boot the **whole Nest application** against a dedicated `pegpal_test` database. They use the mock controller sped up about 20× (`MOCK_TIME_SCALE=20`) and short ACK and completion timeouts. Each test starts from a freshly truncated and seeded database and a fresh app instance. The tests are self-contained and don't need an `.env` file.

```bash
bun run db:up                      # once
bun run test                       # everything
bun run --cwd apps/api test:unit
bun run --cwd apps/api test:integration
```

## Requirement → test map

| Requirement | Test(s) |
|---|---|
| Quantity conversion, density and mass | `units.test.ts` (volume↔mass, density, invalid inputs) |
| Calibration calculations, flow-rate estimation | `units.test.ts`, `plan.spec.ts`, `admin.e2e-spec.ts` (flow-rate and validation runs) |
| Duplicate order requests | `orders.e2e-spec.ts › idempotency` (replay, concurrent same key, key reuse with a different body, repeated confirm → one DISPENSE) |
| Concurrent orders | `orders.e2e-spec.ts › allows only one of many concurrent orders…` |
| Invalid state transitions | `order-state.test.ts`, `orders.e2e-spec.ts › state transitions` |
| Hardware timeouts | `faults.e2e-spec.ts › lost ACKs…`, `› missing completion report…`, `› a lost command packet is recovered…` |
| Emergency stop | `faults.e2e-spec.ts › emergency stop mid-order…`, `› a latched e-stop blocks new orders`, `admin.e2e-spec.ts › clear-fault requires…`, `mock-controller.spec.ts` |
| Controller disconnection | `faults.e2e-spec.ts › controller disconnect mid-dispense…`, `› offline controller…` |
| Recovery after backend restart | `faults.e2e-spec.ts › Recovery after backend restart` (DISPENSING and QUEUED) |
| Failure in the middle of an order | `faults.e2e-spec.ts › pump failure mid-order…` |
| Incorrect or missing sensor readings | `evidence.spec.ts` (unstable, implausible, negative, no density), `faults.e2e-spec.ts › missing scale…`, `› unstable scale…` |
| Cancellation only after a confirmed stop | `orders.e2e-spec.ts › cancelling while dispensing…` |
| Validation (zero, negative, non-integer, string, excessive, unknown fields) | `orders.e2e-spec.ts › validation` |
| Admin authorization | `admin.e2e-spec.ts › authentication` |
| Controller-side rules (dedupe, stale seq, limits, busy, STOP) | `mock-controller.spec.ts` |
| Signing, encryption, tokens | `envelope.spec.ts`, `pricing.spec.ts` |
| Production safety switches | `config.spec.ts` (esp32 flag + TLS, unpaid production refusal, placeholder secrets) |
| Live progress (SSE) | `orders.e2e-spec.ts › streams a snapshot, progress and a final snapshot` |

## Writing new integration tests

`test/helpers.ts` provides the building blocks:

- `createCtx()` resets and seeds the DB, boots the app, and waits for the simulated controller to connect.
- `createOrder`, `confirm`, `waitForTerminal`, `adminToken`, `machineRow`, `dispenseCommandCount`
- `ctx.mock` is the `MockHardwareAdapter`. Call `ctx.mock.configure('MACHINE_T1', { failChannel: 1 })` before confirming to inject a fault.
- Always `await ctx.close()`. It waits for the order runners first.

## Not covered by automated tests

- **Real hardware.** The ESP32 adapter's MQTT transport and the firmware haven't been run against physical pumps or a load cell. Follow the bench checklist in `firmware/README.md`.
- **Browser end-to-end flows.** The UI was checked by hand at 360 px, but there is no Playwright suite yet.
