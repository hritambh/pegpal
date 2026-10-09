# Security

## Threat model (MVP)

| Actor | Can | Must not be able to |
|---|---|---|
| Anyone who scans the QR code | see the machine, create an order, follow their own order | control pumps directly, see other customers' data, reach admin functions |
| Customer holding an order token | confirm or cancel **that** order | affect any other order or machine |
| Authenticated operator | configure, calibrate, stop, clear faults | override the physical e-stop |
| Network attacker / compromised broker | observe traffic (if TLS is broken) | forge commands or completions (HMAC), replay old messages (seq + dedupe) |

## Controls

| Area | Control | Where |
|---|---|---|
| Input validation | Strict DTOs (`whitelist`, `forbidNonWhitelisted`, no implicit coercion). Integers for mL. Server-side limits per liquid, per order and absolute. | `setup-app.ts`, `*.dto.ts`, `orders.service.ts` |
| Pricing | Calculated on the server with decimals. Any client price is rejected as an unknown field. | `pricing.ts` |
| Duplicate orders | Required `Idempotency-Key`. A request hash detects key reuse with a different body. A unique constraint handles concurrent duplicates. | `orders.service.ts` |
| Machine contention | Atomic conditional reservation plus a partial unique index | `orders.service.ts`, migration |
| Order control | `X-Order-Token` = HMAC(`ORDER_TOKEN_SECRET`, orderId), compared in constant time | `order-token.ts` |
| Admin auth | Username + scrypt password hash from env. HS256 JWT with expiry. A guard on every admin controller. Login is rate limited to 5/min and failures are audited. | `admin/*` |
| Rate limiting | Global `RATE_LIMIT_PER_MIN` per IP (`@nestjs/throttler`) | `app.module.ts` |
| Pump control | No unauthenticated endpoint can move a pump. Customers can only trigger the runner for their own confirmed order. Operators use authenticated endpoints. Logical channels only, never GPIO. | `admin.controller.ts`, protocol |
| Controller auth | Per-machine HMAC keys: issued once, encrypted at rest (AES-256-GCM), revocable. Broker ACL per device. TLS required (`mqtts://` enforced by config). | `credentials.service.ts`, `infra/mosquitto` |
| Replay | Commands: strictly increasing `seq` plus a `commandId` dedupe ring on the controller. Events: `eventId` dedupe and a monotonic `deviceSeq` per key, advanced atomically. | `controller.service.ts`, `credentials.service.ts` |
| Secrets | Env only, validated at boot. Production refuses placeholder secrets. `.env` is gitignored. | `config.ts` |
| Logging | Structured logs. Request id on every response. Query strings are stripped. No card data exists anywhere. | `request-id.middleware.ts` |
| Audit | Append-only `DispensingEvent` for commands, controller events, safety events and every admin action, with the actor | `audit.service.ts` |

## Data minimisation

Orders store no personal data: no name, phone, email or IP. Payment fields hold only a mode, a status and, in `TEST_MODE`, a reference prefixed `TEST-`. **Card details are never stored or handled.** A real payment provider must be integrated with its hosted fields or redirect flow, so card data never touches this system.

## Before production

These items still need work:

- [ ] Real payment integration, plus proof of payment before `AUTHORIZED`
- [ ] TLS termination in front of the web and API
- [ ] Strong unique secrets: `openssl rand -base64 48` for JWT and the order token, and 32 random bytes for the encryption key
- [ ] Replace the single env-configured operator with per-user accounts and roles, if more than one operator is needed
- [ ] Rotate machine credentials, and revoke the keys of decommissioned controllers
- [ ] Production MQTT CA and hostnames, and broker hardening
- [ ] Review the CORS origins (same-origin via the web proxy is the default)
- [ ] Back up the database, including the audit log retention policy
