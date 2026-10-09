# Order state machine

Source of truth: [`packages/shared/src/order-state.ts`](../packages/shared/src/order-state.ts).

```
             confirm              start runner         first DISPENSE persisted
 CREATED ─────────────► AUTHORIZED ─────────► QUEUED ─────────────────────► DISPENSING ──► COMPLETED
    │                       │                   │                              │
    │ cancel / expiry       │ cancel            │ cancel (no command sent)     │ STOPPED confirmed after cancel ──► CANCELLED
    ▼                       ▼                   ▼                              │ step FAILED / timeout / disconnect ► FAILED
 CANCELLED              CANCELLED / FAILED   CANCELLED / FAILED / SAFETY_STOPPED  ESTOP ─────────────────► SAFETY_STOPPED
```

| From | Allowed to |
|---|---|
| CREATED | AUTHORIZED, CANCELLED |
| AUTHORIZED | QUEUED, CANCELLED, FAILED |
| QUEUED | DISPENSING, CANCELLED, FAILED, SAFETY_STOPPED |
| DISPENSING | COMPLETED, CANCELLED, FAILED, SAFETY_STOPPED |
| COMPLETED / FAILED / CANCELLED / SAFETY_STOPPED | (terminal) |

## Enforcement

Every transition is one conditional `UPDATE ... WHERE id = ? AND status IN (<allowed sources>)` (`OrdersRepository.transition`). If the update touches zero rows, the transition was illegal or lost a race, and it's rejected with `409 INVALID_TRANSITION`. Two concurrent actors, such as a customer cancelling while the runner starts a pump, therefore can't both succeed.

## Machine reservation

`Machine.activeOrderId` is set by a conditional update (`WHERE activeOrderId IS NULL AND activeCalibrationRunId IS NULL AND status = 'IN_SERVICE'`) in the same transaction that creates the order. A partial unique index, `one_active_order_per_machine`, on `Order(machineId) WHERE status IN (active statuses)` is a second, database-level guarantee. The reservation is released when the order reaches a terminal state.

## Item statuses and evidence

An item becomes `COMPLETED` only on a `DONE` event from the controller for that item's `commandId`. Sending the command, or receiving its ACK, is never enough. Each item carries a `verification` level:

| Level | Meaning |
|---|---|
| `MASS_DELTA` | Change in total glass mass between stable readings around this step, converted with the configured density. Not an independent volume measurement. |
| `ESTIMATED` | Pump runtime × calibrated flow rate. |
| `SIMULATED` | Mock controller. No physical measurement. |
| `UNVERIFIED` | No trustworthy evidence. |

Items whose outcome can't be determined (ACK or completion timeout, disconnect, backend restart mid-step) are marked `UNKNOWN`. The order becomes `FAILED`, and the machine goes to `NEEDS_ATTENTION` until an operator inspects it and clears the fault. Nothing is retried automatically.

## Restart recovery

On boot, `RecoveryService` runs before the API accepts traffic:

- `AUTHORIZED` / `QUEUED` orders with no command sent → `FAILED` ("interrupted before dispensing"), and the machine is released.
- `DISPENSING` orders → `FAILED`. The in-flight item becomes `UNKNOWN` and the rest become `SKIPPED`. A `STOP` is sent once the controller is reachable, and the machine goes to `NEEDS_ATTENTION`.
- `CREATED` orders are left alone. The expiry sweeper cancels them once their TTL passes.

Dispensing never resumes automatically.
