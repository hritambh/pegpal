# Getting started

## Prerequisites

| Tool | Version | Used for |
|---|---|---|
| [Bun](https://bun.sh) | 1.4.x | package management and running scripts |
| Node.js | 22.x | runtime for NestJS, Next.js and Jest |
| Docker + Compose | recent | PostgreSQL (and optionally the full stack) |
| PlatformIO | optional | building the ESP32 firmware |

> A local Postgres on 5432 is fine. The compose database publishes on **5433** so the two don't clash. Override with `POSTGRES_HOST_PORT`.

## Option A: local development (recommended)

```bash
# 1. Install dependencies (all workspaces)
bun install

# 2. Start PostgreSQL (also creates the pegpal_test database on first start)
bun run db:up

# 3. Configure the API
cp apps/api/.env.example apps/api/.env
#    then set MACHINE_SECRET_ENCRYPTION_KEY:  openssl rand -base64 32
#    the example ADMIN_PASSWORD_HASH is for the dev password "pegpal-dev-password"

# 4. Build shared types, generate the Prisma client, migrate and seed
bun run build:shared
bun run --cwd apps/api prisma:generate
bun run db:migrate
bun run db:seed

# 5. Run (two terminals)
bun run dev:api      # http://localhost:3001/api/health
bun run dev:web      # http://localhost:3000
```

Open:

| URL | What |
|---|---|
| http://localhost:3000/machine/MACHINE_001 | the customer flow (what the QR code opens) |
| http://localhost:3000/admin | operator dashboard. Log in as `operator` / `pegpal-dev-password` |
| http://localhost:3001/api/health | API health |

Everything runs in **mock hardware mode**. The dashboard shows a `MOCK hardware (simulated)` badge, and every measurement is labelled simulated.

## Option B: full stack in Docker

```bash
cp apps/api/.env.example apps/api/.env      # and set MACHINE_SECRET_ENCRYPTION_KEY
docker compose --profile app up --build -d
docker compose exec api ./node_modules/.bin/tsx prisma/seed.ts   # first run only
```

The API container applies migrations on start. The web app is served on :3000 and the API on :3001.

## Trying the fault simulator

On `/admin`, the **Simulator** panel (mock mode only) can do the following:

- disconnect the controller
- press or release the simulated physical e-stop
- change flow-rate multipliers, globally or per channel
- fail a pump channel part-way
- drop ACKs (a broken uplink)
- never send DONE (a hung step)
- disconnect or e-stop at a given fraction of a step
- simulate an unstable or missing scale

Start an order on your phone, trigger a fault, and watch both screens.

A machine that ends up in **NEEDS_ATTENTION** stays locked until an operator presses **Clear fault**. That requires a fresh controller status with no pump running and no e-stop latched.

## Testing a phone against your laptop

Phones can't reach `localhost`. Run the web app on your LAN IP (`bun run --cwd apps/web dev -- -H 0.0.0.0`) and open `http://<lan-ip>:3000/machine/MACHINE_001`. Generate a QR code for that URL with any QR tool.

## Common scripts

| Command | Where | What |
|---|---|---|
| `bun run test` | root | all tests (shared, api unit + integration, web) |
| `bun run lint` / `bun run typecheck` | root | every workspace |
| `bun run --cwd apps/api test:unit` | api | fast unit tests (no DB) |
| `bun run --cwd apps/api test:integration` | api | integration tests (needs `bun run db:up`) |
| `bun run --cwd apps/api hash-password '<pw>'` | api | generate `ADMIN_PASSWORD_HASH` |
| `bun run --cwd apps/api prisma:migrate:dev` | api | create a new migration after editing the schema |

## Configuration reference

Everything is environment-based and validated at startup. Invalid configuration stops the process with a list of problems. See [`apps/api/.env.example`](../apps/api/.env.example) for every variable with comments. The ones that matter most:

| Variable | Default | Notes |
|---|---|---|
| `HARDWARE_MODE` | `mock` | `esp32` **also** needs `ENABLE_ESP32_ADAPTER=true` and an `mqtts://` URL |
| `PAYMENT_MODE` | `TEST_MODE` | or `PAYMENT_DISABLED`. Neither takes real money. |
| `ALLOW_UNPAID_DISPENSING` | `false` | required to start with `NODE_ENV=production` |
| `ORDER_MAX_TOTAL_ML` / `ORDER_MAX_ITEMS` | 400 / 10 | server-side order limits |
| `PUMP_MAX_RUNTIME_MS` | 60000 | per pump step. The firmware has its own cap. |
| `ORDER_MAX_DURATION_MS` | 300000 | whole order |
| `ACK_TIMEOUT_MS` × `ACK_RETRIES` | 1500 × 3 | retransmission budget before an outcome is uncertain |
| `SCALE_FITTED` | `false` | tare and record mass evidence for timed liquids too |
| `MOCK_TIME_SCALE` | `1` | above 1 speeds up the simulator |

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Invalid configuration: …` on start | Read the list. Each line names the variable. |
| Machine shows **Offline** | In mock mode, check the API logs. In esp32 mode, check the broker, credentials and presence topic. |
| Machine shows **Out of service** | It's `OUT_OF_SERVICE`, `NEEDS_ATTENTION`, or the e-stop is latched. See the dashboard. |
| `P1001 Can't reach database` | Run `bun run db:up`, and check `DATABASE_URL` uses port 5433. |
| Integration tests fail to connect | The `pegpal_test` DB is created on the first Postgres start. To recreate it: `docker compose down -v && bun run db:up`. |
