# Operations runbook

## Machine states at a glance

| Dashboard shows | Customers see | Meaning | What to do |
|---|---|---|---|
| In service · Connected | Available / Busy | normal | nothing |
| Out of service | Out of Service | an operator took it out | **Set in service** when ready |
| **Needs attention** | Out of Service | the backend couldn't confirm what a pump did, or a safety event interrupted an order | see *Clearing a fault* |
| E-stop active | Out of Service | the physical button is latched | find the cause, release the button and reset it **locally** |
| Disconnected | Offline | no link to the controller | check power, Wi-Fi and the broker. Pumps stop locally after `LINK_LOSS_STOP_MS`. |

## Clearing a fault

`NEEDS_ATTENTION` is deliberately sticky. Software can't know what actually happened, for example whether liquid came out or a pump is still primed.

1. Look at the machine: the glass, the drip tray and the tubing.
2. On the dashboard, open **Safety & error events** and the order's events. Look for `DISPENSE_OUTCOME_UNKNOWN`, `ESTOP_PRESSED`, `CONTROLLER_FAULT` or `ORDER_RECOVERED_AFTER_RESTART`.
3. Make sure the physical e-stop is released and reset.
4. Press **Clear fault** and add a note. The backend asks the controller for a fresh `STATUS` and refuses if any pump is on or the e-stop is latched. Your note goes in the audit log.

A customer whose order ended `FAILED` or `SAFETY_STOPPED` sees the reason and a "please contact staff" message. The order shows which items completed and how each amount was verified.

## Emergency stop

- **Physical button (primary).** It cuts motor power in hardware and also latches the controller. It works with no backend, no Wi-Fi and no internet. No API or UI can release it.
- **Stop all pumps (dashboard).** A software STOP. The order in progress ends `FAILED` ("Stopped by operator"). If the controller doesn't confirm the stop, the machine goes to `NEEDS_ATTENTION` and the UI tells you to use the physical button.

## Backend restarts

The backend never resumes dispensing on its own. At boot, `RecoveryService` does the following:

| Was | Becomes | Machine |
|---|---|---|
| `AUTHORIZED` / `QUEUED` (no pump command sent) | `FAILED`: "interrupted before dispensing" | released, stays in service |
| `DISPENSING` | `FAILED`: "outcome unverified". The current item is `UNKNOWN`. | `NEEDS_ATTENTION` |
| a calibration run `RUNNING` | `FAILED` | `NEEDS_ATTENTION` |
| `CREATED` | unchanged; expires after `ORDER_CONFIRM_TTL_SEC` | |

If a controller reports a pump running that the new process didn't start, the backend sends STOP and locks the machine.

## Machine credentials (ESP32)

| Task | How |
|---|---|
| Issue | `POST /api/admin/machines/:id/credentials`. The secret is shown **once**. Flash it into `firmware/include/secrets.h`. |
| Rotate | Issue a new key, reflash, then revoke the old one. The backend always signs with the newest unrevoked key. |
| Revoke | `POST /api/admin/credentials/:keyId/revoke`. Messages signed with that key are dropped and audited from then on. |

## Liquids and pumps

- **Rename or reprice:** on the Liquids & pumps page. Changes apply to new orders. Existing orders keep the name and price they were created with.
- **Move a liquid to another channel:** this clears its calibration, so recalibrate before customers can order it.
- **Set stock:** stock goes down by the delivered (or requested) amount. A liquid with less stock than its minimum shows "Out of stock".

## Logs

- The API writes structured logs. Set `LOG_JSON=true` for one JSON object per line.
- Every HTTP response carries `X-Request-Id`. Error bodies include `requestId` too.
- The durable audit trail is the `DispensingEvent` table, shown at `/admin/events` with filters by machine, order and severity.
