# HTTP API

Base path: `/api`. Request and response types are in [`packages/shared/src/api-types.ts`](../packages/shared/src/api-types.ts). Every request body is validated strictly: unknown fields are rejected, and so are wrong types and out-of-range values.

## Conventions

- **Errors** use one shape everywhere (`ApiError`):

  ```json
  { "statusCode": 422, "error": "Unprocessable Entity", "message": "...", "details": ["items.0.volumeMl must not be greater than 100"], "requestId": "..." }
  ```

- **Request IDs:** every response carries `X-Request-Id`. You can supply your own.
- **Rate limits:** the global limit is configurable (`RATE_LIMIT_PER_MIN`). Admin login is stricter. When a limit is exceeded the API returns `429`.
- **Money:** amounts are decimal strings in the machine's currency, e.g. `"2.50"`. The server computes all prices and ignores any price the client sends.
- **Volumes:** integer mL.

| Status | Meaning |
|---|---|
| 400 | malformed request or validation failure |
| 401 | missing or invalid admin token or order token |
| 404 | unknown machine, liquid, or order |
| 409 | conflict: machine busy, invalid state transition, idempotency key reused with a different body |
| 422 | well-formed but not allowed: quantity limits, inactive liquid, machine not operational |
| 429 | rate limited |
| 503 | hardware unavailable |

## Customer endpoints

### `GET /api/machines/:machineId`
`machineId` is the public id from the QR code. Returns `MachinePublicView`, or `404` if unknown.

### `GET /api/machines/:machineId/liquids`
Returns `LiquidPublicView[]` sorted by pump channel. Inactive liquids are excluded. Uncalibrated liquids and liquids without enough stock come back with `available: false` and a reason.

### `POST /api/orders`
Headers: `Idempotency-Key: <8-128 chars [A-Za-z0-9_-]>` (required).
Body: `CreateOrderRequest`.

Rules:
- 1 to `maxItems` items, and no liquid more than once.
- Each `volumeMl` must be an integer within that liquid's `[minMl, maxMl]`.
- The sum must not exceed `ORDER_MAX_TOTAL_ML`.
- The liquid must be active, calibrated, belong to this machine, and have enough stock.
- The machine must be `AVAILABLE`. The order reserves it atomically. If another order holds the machine, the API returns `409 MACHINE_BUSY`.

Responses:
- `201 CreateOrderResponse` for a new order.
- `200` with the same body when the same key is replayed with the same body.
- `409` when the key is reused with a different body.

Unconfirmed orders expire after `ORDER_CONFIRM_TTL_SEC`, which releases the machine.

### `GET /api/orders/:orderId`
Returns `OrderView`. Order ids are random UUIDs and contain no personal data.

### `POST /api/orders/:orderId/confirm`
Headers: `X-Order-Token` (from create). Body: `ConfirmOrderRequest`.

- `TEST_MODE`: requires `testPaymentConfirmed: true`. The payment is recorded as `TEST_CONFIRMED` with `isTest: true`. **No money moves.**
- `PAYMENT_DISABLED`: no payment step, recorded as `NOT_REQUIRED`. The server refuses to start in production with this mode unless `ALLOW_UNPAID_DISPENSING=true`.

Confirming moves the order `CREATED → AUTHORIZED → QUEUED`, and dispensing then starts in the background. The call is idempotent: confirming an order that's already confirmed returns its current state. Returns `200 OrderView`.

### `POST /api/orders/:orderId/cancel`
Headers: `X-Order-Token`.

- Before any pump command has been sent, the order becomes `CANCELLED` straight away (`200`).
- While dispensing, the API sets `cancelRequested: true`, sends `STOP`, and returns `202`. The order only becomes `CANCELLED` once the controller confirms every pump is off. If no confirmation arrives, the order becomes `FAILED` and the machine needs operator attention.
- On a terminal order, the API returns the current state (`200`) and changes nothing.

### `GET /api/orders/:orderId/events`
A Server-Sent Events stream of `OrderStreamMessage`:
- a `snapshot` straight away, then on every persisted change;
- `progress` while a pump runs.

The stream closes shortly after the order reaches a terminal state. Clients should fall back to polling `GET /api/orders/:id` if the stream drops.

### `GET /api/health`
`{ status: "ok" | "degraded", db: boolean, hardwareMode, uptimeSec }`. Returns `503` when the DB is down.

## Admin endpoints

All of them require `Authorization: Bearer <jwt>` from login.

| Method | Path | Body / query | Returns |
|---|---|---|---|
| POST | `/api/admin/auth/login` | `AdminLoginRequest` | `AdminLoginResponse` |
| GET | `/api/admin/overview` | | `AdminOverview` |
| GET | `/api/admin/orders` | `?machineId&limit` | `OrderView[]` (newest first) |
| GET | `/api/admin/events` | `?machineId&orderId&severity&limit` | `DispensingEventView[]` |
| PATCH | `/api/admin/machines/:id` | `{ status: "IN_SERVICE" \| "OUT_OF_SERVICE" }` | `AdminMachineView` |
| POST | `/api/admin/machines/:id/stop` | `{ reason }` | `AdminMachineView`. Software STOP of all pumps. |
| POST | `/api/admin/machines/:id/clear-fault` | `{ note }` | `AdminMachineView`. Requires a fresh controller STATUS with no pump on and no e-stop. |
| GET | `/api/admin/machines/:id/liquids` | | `AdminLiquidView[]` |
| POST | `/api/admin/machines/:id/liquids` | `UpsertLiquidRequest` | `AdminLiquidView` |
| PATCH | `/api/admin/liquids/:liquidId` | `Partial<UpsertLiquidRequest>` | `AdminLiquidView` |
| GET | `/api/admin/calibration/runs` | `?liquidId&limit` | `CalibrationRunView[]` |
| POST | `/api/admin/calibration/runs` | `StartCalibrationRequest` | `CalibrationRunView` (status `RUNNING`) |
| GET | `/api/admin/calibration/runs/:id` | | `CalibrationRunView` |
| POST | `/api/admin/calibration/runs/:id/measurement` | `CalibrationMeasurementRequest` | `CalibrationRunView` |
| POST | `/api/admin/calibration/runs/:id/apply` | | `AdminLiquidView` (FLOW_RATE runs only) |
| GET | `/api/admin/machines/:id/credentials` | | `MachineCredentialView[]` |
| POST | `/api/admin/machines/:id/credentials` | | `IssuedMachineCredential` (secret shown once) |
| POST | `/api/admin/credentials/:keyId/revoke` | | `MachineCredentialView` |
| GET | `/api/admin/mock/:id` | | `MockStateView` (mock mode only, else 404) |
| PUT | `/api/admin/mock/:id/config` | `Partial<MockFaultConfig>` | `MockStateView` |
| POST | `/api/admin/mock/:id/estop` | `{ active: boolean }` | `MockStateView`. Simulates the *physical* button. |
| POST | `/api/admin/mock/:id/connection` | `{ connected: boolean }` | `MockStateView` |

In admin routes, `:id` is the machine's internal id (`AdminMachineView.id`). Pump-control endpoints require an authenticated operator. No endpoint can clear a physical e-stop.
