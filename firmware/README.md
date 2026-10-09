# PegPal controller firmware (ESP32)

> **Status: UNTESTED ON HARDWARE.** This firmware compiles (see "Build") but has
> not run on a real board, pump, load cell or e-stop circuit. Pin numbers in
> `include/config.h` are placeholders. Do not connect pumps to liquids, mains
> power or customers until the bench checklist below has passed on your build.
> Software is never the primary safety layer: read [`docs/safety.md`](../docs/safety.md).

This firmware implements the controller side of
[`docs/hardware-protocol.md`](../docs/hardware-protocol.md) (TypeScript
definitions in `packages/shared/src/protocol.ts`).

## Why the Arduino framework (and not ESP-IDF directly)

- The libraries this device needs (HX711, MQTT over TLS through
  `WiFiClientSecure`, JSON, NVS through `Preferences`) are mature, widely used
  and quick to integrate on Arduino-ESP32.
- MVP iteration is faster: PlatformIO builds, one `setup()/loop()`, serial console.
- Nothing important is lost. The Arduino core runs on ESP-IDF and FreeRTOS, so
  `esp_task_wdt`, hardware timers, `esp_timer`, mbedTLS (`mbedtls/md.h` for
  HMAC-SHA256) and direct GPIO register access are all still available and used.
- If finer control is needed later (separate FreeRTOS tasks for network and
  dispensing, IRAM-only ISRs, secure boot / flash encryption workflows, OTA with
  rollback), migrate to ESP-IDF. The modules are small and mostly framework-neutral.

Pinned versions (`platformio.ini`): platform `espressif32@6.9.0` (Arduino-ESP32
core 2.0.17, ESP-IDF 4.4), `bblanchon/ArduinoJson@7.2.1`, `bogde/HX711@0.7.5`,
`256dpi/MQTT@2.5.2`. The hardware-timer and `esp_task_wdt_init` calls use the
core 2.x API; core 3.x changed both, so moving platforms means porting
`src/pumps.cpp` and `setup()` in `src/main.cpp`.

**MQTT library choice:** `256dpi/MQTT` (lwmqtt) is used instead of PubSubClient
because PubSubClient can only *publish* at QoS 0. The protocol sends events at
QoS 1, and the firmware keeps important events in an outbox until the broker
returns PUBACK, so a `FAILED code=CONNECTION_LOST` really is "reported when the
link returns". PROGRESS is sent at QoS 0 and dropped while offline.

## Layout

| File | Role |
|---|---|
| `include/config.h` | Every limit and the pin map (placeholders). Compile-time only. |
| `include/secrets.example.h` | Template for the gitignored `include/secrets.h`. |
| `src/main.cpp` | Setup order (pumps OFF first), watchdog, non-blocking loop. |
| `src/pumps.*` | Output init, single active pump, hardware-timer runtime cap, ISR-safe stop. |
| `src/estop.*` | E-stop ISR latch, polling backup, local reset button. |
| `src/scale.*` | HX711 reads, median + moving-average filter, stability, tare, glass detection. |
| `src/dispenser.*` | TIMED / WEIGHT state machine, PROGRESS, DONE/FAILED, fault checks. |
| `src/commands.*` | Envelope intake, validation, 16-entry idempotency ring, dispatch. |
| `src/protocol.*` | HMAC-SHA256 sign/verify (constant time), envelopes, event base, UUIDs. |
| `src/events.*` | Event builders (field names from `protocol.ts`) and the send path. |
| `src/link.*` | Wi-Fi, MQTT/TLS, LWT, SNTP, outbox/inbox (namespace `net`). |
| `src/store.*` | NVS: `lastSeq`, `deviceSeq` high-water mark, `inFlight`, scale calibration. |
| `src/console.*` | Local USB serial console: scale calibration; bench-only pump test. |

## Build and flash

```sh
python3 -m venv .venv && . .venv/bin/activate
pip install platformio
cp include/secrets.example.h include/secrets.h   # then fill it in (see Provisioning)
pio run                          # build env esp32dev
pio run -t upload                # flash over USB
pio device monitor               # 115200 baud
pio run -e esp32dev-bench -t upload   # bench build: no network, console pump test
```

Use a different board by adding an `[env:...]` with another `board =` and
re-checking the pin map (strapping pins differ between ESP32 variants).

## Provisioning

1. In the backend, create the machine, then issue a credential:
   `POST /api/admin/machines/:id/credentials` returns `{ keyId, secret }`. The
   secret is shown once.
2. Copy `include/secrets.example.h` to `include/secrets.h` and fill in:
   `MACHINE_ID` (the machine's public id), `HMAC_KEY_ID`, `HMAC_SECRET` (exactly
   as issued: the HMAC key is the UTF-8 bytes of that string, not decoded),
   the Wi-Fi credentials, the broker host/port, this machine's own broker
   username/password (ACL-limited to `pegpal/v1/{machineId}/#`), and the PEM of
   the CA that signed the broker certificate.
3. Build and flash. `secrets.h` is gitignored; never commit it.
4. To rotate or revoke: `POST /api/admin/credentials/:keyId/revoke`, issue a new
   credential, reflash. The firmware only knows one key, so revocation takes
   effect on the backend immediately and on the device at reflash.
   Changing `HMAC_KEY_ID` restarts `deviceSeq` from 1 (protocol: "resets only on
   credential change").

Secrets live in flash in plain text unless you enable ESP32 flash encryption and
secure boot. Do that before field deployment.

## HX711 calibration (known reference mass)

Use the serial console (`pio device monitor`). It is local-only and works in
both builds; calibration commands are refused while a pump runs.

1. Mount the load cell and platform as in service. Power up and wait ~1 min to warm up.
2. With the platform **empty**, wait until `show` reports `stable=1`, then run
   `zero`. This stores the empty-platform baseline used for glass detection
   (`platformMassG`, `MIN_GLASS_MASS_G`).
3. Place a known reference mass (ideally a calibration weight near a full glass,
   e.g. 200 g or 500 g; at least 10 g) in the middle of the platform. Wait for
   `stable=1`, then run `cal <grams>`, e.g. `cal 500`. This stores
   `countsPerG = (filteredRaw - emptyRaw) / grams` in NVS. The sign follows the
   load-cell wiring and is handled.
4. Verify with a second, different known mass: `show` should report it within
   your tolerance (target: better than ±1 g). Check corners of the platform too.
5. Copy the value into `SCALE_DEFAULT_COUNTS_PER_G` in `config.h` so a fresh
   board has a sane default. Re-run `zero` whenever the platform or mounting changes.
6. Tune `STABLE_STDDEV_G` against your noise floor: with the platform still,
   the reading must be "stable" within ~1 s; with a pump running into a glass it
   must not be.

The HX711 is assumed to run at 10 samples/s (RATE pin low). At 80 SPS, the
filter windows in `config.h` cover a shorter time; scale them up accordingly.

## Bench test checklist (before any liquid)

Do these with pumps **disconnected from liquids** (dry or into an empty
container), on the bench PSU with current limiting, using the bench build
unless noted. Record results.

1. **Pin map:** confirm every pin in `config.h` against the schematic. Correct
   `PUMP_ON_LEVEL` / `MOTOR_ENABLE_ON_LEVEL` polarity.
2. **Reset/boot state:** with a scope or LEDs on every pump driver input and the
   relay coil, power-cycle, press EN/reset, hold BOOT, and flash. No pump may
   twitch at any point. If one does, fix the gate pull-downs (`docs/safety.md`).
3. **Each channel:** `pump <ch> 1000` runs only that pump for ~1 s. Disabled
   channels (`ENABLED_CHANNEL_MASK`) are refused.
4. **Hardware cap:** `pump 0 999999` is refused; `pump 0 <FW_MAX_PUMP_RUNTIME_MS>`
   stops on time with "(hardware timer)".
5. **E-stop:** while a pump runs, press the mushroom switch. Motor power must
   drop in hardware (measure the motor rail) **and** the console must show the
   latch. Release the switch: the latch stays. Hold reset for 1 s: it clears.
   Pulling the e-stop signal wire must also latch (fail-safe wiring).
6. **Reset button without release:** with the switch still pressed, the reset
   button must not clear the latch.
7. **Scale:** calibrate (above). Unplug the HX711 data line: `show` reports
   `healthy=0` within `SCALE_TIMEOUT_MS`.
8. **Watchdog:** temporarily add `while (true) {}` behind a console command in a
   scratch build; the chip must reset within `WDT_TIMEOUT_S` and all pumps stay off.
9. **Network build, broker connected:** STATUS on connect and every 10 s; LWT
   `online=0` when you cut power; a command with a bad signature gets no ACK;
   a replayed command gets `ACK duplicate=true` and does not run the pump.
10. **Link loss:** start a long TIMED dispense, disconnect Wi-Fi: the pump stops
    after `LINK_LOSS_STOP_MS` and `FAILED code=CONNECTION_LOST` arrives on reconnect.
11. **Faults (WEIGHT, water only):** lift the glass mid-pour
    (`UNEXPECTED_MASS_CHANGE`), press on the glass (`UNEXPECTED_MASS_CHANGE`),
    run with an empty reservoir (`NO_FLOW_DETECTED`), no glass (`NO_GLASS`).
12. **Reboot mid-dispense:** power-cycle during a pump run. Nothing resumes;
    STATUS reports `lastCommandOutcome=UNKNOWN`.

## Behaviour notes and known limitations

- **Time:** DISPENSE is rejected until SNTP has synced (`REQUIRE_TIME_SYNC_FOR_DISPENSE`,
  stricter than the spec, which only rejects stale commands when synced).
- **Blocking network calls:** the MQTT/TLS connect blocks for up to
  `TLS_HANDSHAKE_TIMEOUT_S`, so reconnects are never attempted while a pump
  runs. A QoS 1 publish waits for PUBACK (up to `MQTT_TIMEOUT_MS`), so periodic
  STATUS is deferred while a pump runs and at most one queued event (e.g. the
  ACK, if the pump started first) is published per loop while pumping. On a
  slow link this can delay a WEIGHT cutoff by up to one broker round trip;
  `cutoffMarginG` must cover it until network I/O moves to its own task.
- **Link loss** is detected at once when Wi-Fi drops; a dead TCP session with
  Wi-Fi still up is only noticed after the MQTT keepalive (about 1.5 x
  `MQTT_KEEPALIVE_S`), so the effective stop time in that case is keepalive
  plus `LINK_LOSS_STOP_MS`. Pumps never rely on the loop to stop:
  the hardware timer and the e-stop ISR handle that.
- **STOP:** pumps go off immediately and `STOPPED` is sent at once; its
  `massDeltaG` is only filled if the scale happens to be stable at that moment
  (usually null).
- **Duplicate replay** re-sends the stored final event body with a fresh
  `eventId`/`deviceSeq`, so the backend's event dedup does not discard it.
- **`bootedRecently`** is cleared when the controller answers a `STATUS_REQUEST`.
- `deviceSeq` is persisted as a high-water mark every 1000 events (flash wear),
  so after a reboot it skips ahead rather than repeating.
- A single loop task does everything. Splitting network I/O into its own FreeRTOS
  task would remove the remaining blocking concerns. That is the main ESP-IDF-style follow-up.
