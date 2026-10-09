# Data model

Source of truth: [`apps/api/prisma/schema.prisma`](../apps/api/prisma/schema.prisma). Migrations live in `apps/api/prisma/migrations`.

```
Machine 1──* Liquid 1──* OrderItem *──1 Order *──1 Machine
   │                                       │
   ├──* HardwareCommand *──────────────────┤ (orderId, orderItemId, calibrationRunId)
   ├──* DispensingEvent  (audit) ──────────┘
   ├──* MachineCredential
   └──* CalibrationRun *──1 Liquid
```

## Tables

### Machine
| Column | Notes |
|---|---|
| `publicId` | printed in the QR URL; unique |
| `status` | `IN_SERVICE` / `OUT_OF_SERVICE` / `NEEDS_ATTENTION` (operator-controlled; the system sets NEEDS_ATTENTION) |
| `hardwareConnection` | `CONNECTED` / `DISCONNECTED` / `UNKNOWN` |
| `estopActive`, `faultReason` | latest controller report and lock reason |
| `activeOrderId`, `activeCalibrationRunId` | the reservation (unique, set atomically) |
| `commandSeq` | monotonic protocol sequence |
| `lastSeenAt`, `lastStatus` | liveness and the last STATUS payload |

### Liquid
| Column | Notes |
|---|---|
| `pumpChannel` | logical channel 0–9, unique per machine (DB check constraint) |
| `strategy`, `flowRateMlPerSec`, `densityGPerMl`, `cutoffMarginG`, `calibratedAt`, `calibrationSimulated` | the calibration profile ([details](dispensing-and-calibration.md)) |
| `minMl`, `maxMl` | per-liquid limits (check: `0 < min ≤ max`) |
| `pricePerMl` | `DECIMAL(12,4)` |
| `active`, `remainingStockMl` | availability |

### Order
| Column | Notes |
|---|---|
| `status` | see [state-machine.md](state-machine.md) |
| `totalVolumeMl`, `totalPrice`, `currency` | computed by the server |
| `idempotencyKey` (unique), `requestHash` | duplicate protection |
| `paymentMode`, `paymentStatus`, `paymentReference` | never card data |
| `cancelRequestedAt`, `failureReason`, `expiresAt` | |
| `authorizedAt`, `dispensingStartedAt`, `finishedAt` | timeline |

Partial unique index `one_active_order_per_machine` on `(machineId) WHERE status IN (CREATED, AUTHORIZED, QUEUED, DISPENSING)`.

### OrderItem
| Column | Notes |
|---|---|
| `position` | execution order |
| `liquidName`, `pumpChannel`, `unitPrice`, `linePrice` | snapshot taken at order time |
| `requestedMl`, `targetMassG` | the target |
| `status` | `PENDING`, `DISPENSING`, `COMPLETED`, `FAILED`, `STOPPED`, `SKIPPED`, `UNKNOWN` |
| `deliveredMl`, `measuredMassG`, `runtimeMs`, `verification`, `verificationNote` | the evidence |
| `startedAt`, `completedAt` | |

### HardwareCommand
This table records every command, and each row is written **before** the command is sent. Columns: `id` (= protocol `commandId`), `seq`, `type`, `payload`, `outcome` (`PENDING`, `ACKED`, `REJECTED`, `DONE`, `FAILED`, `STOPPED`, `UNKNOWN`), `attempts`, `ackedAt`, `finishedAt`, `result`.

### DispensingEvent (audit log)
An append-only table with these columns: `type`, `severity` (`INFO`, `WARN`, `SAFETY`), machine/order/calibration/liquid/channel references, a JSON `payload`, `actor` (the operator username, for admin actions), and `createdAt`.

### MachineCredential
`keyId`, `secretEncrypted` (AES-256-GCM), `lastDeviceSeq` (replay guard), `lastUsedAt`, `revokedAt`.

### CalibrationRun
`kind` (`FLOW_RATE` / `VALIDATION`), `status`, commanded and actual runtime, `targetMl`, `measuredMl`, `measuredMassG`, computed density, flow and error %, `previousFlowRate`, `simulated`, `simulatedReadingMl`, `applied`, `operator`.
