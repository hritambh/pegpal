// PegPal controller: compile-time limits and pin map.
//
// Nothing in this file can be changed by a network message. Commands name a
// logical channel 0..9; only PUMP_PINS below turns that into a GPIO.
//
// UNTESTED ON HARDWARE. Every pin number below is a PLACEHOLDER. VERIFY AGAINST
// YOUR WIRING before powering pumps.
#pragma once

#include <stdint.h>

#define FIRMWARE_VERSION "0.1.0-untested"
#define PROTOCOL_VERSION 1

// Set to 1 by the esp32dev-bench environment: no network, serial console only.
#ifndef PEGPAL_BENCH_MODE
#define PEGPAL_BENCH_MODE 0
#endif

// ---------------------------------------------------------------------------
// Pin map: PLACEHOLDERS - VERIFY AGAINST YOUR WIRING.
//
// Chosen for a generic ESP32-WROOM-32 devkit ("esp32dev"):
//  - avoids strapping pins (GPIO0, 2, 5, 12, 15), which have boot-time pulls
//    and can glitch at reset;
//  - avoids GPIO6..11 (SPI flash), GPIO1/3 (UART0, used for the console),
//    GPIO14 (emits a signal during boot);
//  - GPIO34..39 are input-only and have NO internal pull-ups.
//  - GPIO16/17 are used by PSRAM on WROVER modules. Move pumps 1/2 if your
//    board has PSRAM.
// Every pump driver needs an external gate pull-down so it stays OFF while the
// ESP32 is in reset or the bootloader (see docs/safety.md).
// ---------------------------------------------------------------------------
#define PUMP_CHANNEL_COUNT 10

// Index = logical channel. PLACEHOLDER pins.
static const uint8_t PUMP_PINS[PUMP_CHANNEL_COUNT] = {
    13, 16, 17, 18, 19, 21, 22, 23, 25, 26,
};
// Pump driver input polarity. HIGH = pump on (low-side MOSFET with gate pull-down).
#define PUMP_ON_LEVEL 1

// Motor-supply enable relay/contactor coil driver (in series with, never instead
// of, the hardware e-stop circuit). PLACEHOLDER pin.
#define MOTOR_ENABLE_PIN 27
// Level that energizes the relay. Many relay modules are active-LOW; set this to
// 0 for those. "Off" is always the opposite level.
#define MOTOR_ENABLE_ON_LEVEL 1

// HX711. PLACEHOLDER pins.
#define HX711_DOUT_PIN 34  // input-only pin; the HX711 drives it push-pull
#define HX711_SCK_PIN 32

// E-stop status contact (the SECOND contact of the mushroom switch; the first one
// breaks motor power in hardware). PLACEHOLDER pin. Wire the NC contact between
// this pin and GND with an EXTERNAL pull-up to 3.3 V (GPIO35 has no internal
// pull-up). Normal = contact closed = LOW. Pressed or wire broken = HIGH = e-stop.
#define ESTOP_PIN 35
#define ESTOP_ACTIVE_LEVEL 1

// Local e-stop reset button (momentary, NO, to GND). PLACEHOLDER pin.
#define ESTOP_RESET_PIN 33
#define ESTOP_RESET_ACTIVE_LEVEL 0

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------
// Bit n set = logical channel n may run. Disable channels that are not plumbed.
#define ENABLED_CHANNEL_MASK 0x03FFu

// ---------------------------------------------------------------------------
// Dispense limits (firmware layer; the backend has its own independent limits)
// ---------------------------------------------------------------------------
#define FW_MAX_PUMP_RUNTIME_MS 30000u   // hard cap on any single pump run
#define FW_MAX_ML_PER_DISPENSE 120.0f   // largest single-step volume accepted
// WEIGHT steps: targetMassG may not exceed FW_MAX_ML_PER_DISPENSE x this density,
// so a large mass target cannot bypass the volume limit.
#define FW_MAX_DENSITY_G_PER_ML 1.5f
#define FW_MIN_RUNTIME_MS 50u           // TIMED runtimes below this are rejected
#define PROGRESS_INTERVAL_MS 250u

// ---------------------------------------------------------------------------
// Link / time
// ---------------------------------------------------------------------------
#define LINK_LOSS_STOP_MS 3000u           // stop a running pump after this long offline
#define COMMAND_MAX_AGE_MS 30000u         // reject DISPENSE whose issuedAt is older
#define COMMAND_MAX_FUTURE_SKEW_MS 5000u  // reject DISPENSE issued "in the future"
// The protocol spec only rejects old commands when the clock is synced. This
// build is stricter: with 1, a DISPENSE is rejected until SNTP has synced.
#define REQUIRE_TIME_SYNC_FOR_DISPENSE 1
#define STATUS_INTERVAL_MS 10000u
#define WIFI_RETRY_MS 5000u
#define MQTT_RETRY_MS 5000u
#define MQTT_KEEPALIVE_S 10
#define MQTT_TIMEOUT_MS 1000              // per publish/subscribe ack wait
#define TLS_HANDSHAKE_TIMEOUT_S 5
#define MQTT_BUFFER_SIZE 2048             // read and write buffer, bytes
#define SNTP_SERVER_1 "pool.ntp.org"
#define SNTP_SERVER_2 "time.google.com"
#define TIME_VALID_AFTER_EPOCH_S 1704067200L  // 2024-01-01; earlier = not synced

// ---------------------------------------------------------------------------
// Scale (HX711 + single load cell)
// ---------------------------------------------------------------------------
// Defaults until a calibration is stored in NVS via the serial console.
#define SCALE_DEFAULT_COUNTS_PER_G 420.0f  // PLACEHOLDER: calibrate per load cell
#define SCALE_TIMEOUT_MS 500u              // HX711 not ready this long = SCALE_FAULT
#define SCALE_MEDIAN_WINDOW 5              // raw samples per median
#define SCALE_AVG_WINDOW 4                 // medians in the moving average
#define SCALE_STABLE_WINDOW 10             // filtered samples used for stddev
#define STABLE_STDDEV_G 0.6f               // stddev below this = stable
#define TARE_TIMEOUT_MS 4000u              // TARE gives up if not stable in time
#define TARE_VALID_MS 120000u              // WEIGHT needs a tare this recent
#define MIN_GLASS_MASS_G 40.0f             // platform mass above empty baseline = glass present
#define SCALE_MAX_PLATFORM_G 3000.0f       // above this the reading is implausible
#define PRE_SETTLE_TIMEOUT_MS 2000u        // wait for a stable "before" reading
#define POST_SETTLE_TIMEOUT_MS 2500u       // wait for a stable "after" reading

// Faults while a pump runs (all stop the pump)
#define MASS_DROP_FAULT_G 15.0f            // drop from the peak (glass lifted)
#define MAX_PLAUSIBLE_FLOW_G_PER_S 60.0f   // faster gain = something pressed on the glass
#define FLOW_RATE_WINDOW_MS 500u           // window for the rate check
#define NO_FLOW_TIMEOUT_MS 2500u           // no gain by then = NO_FLOW_DETECTED
#define NO_FLOW_MIN_GAIN_G 2.0f            // "gain" threshold for the no-flow check

// ---------------------------------------------------------------------------
// E-stop
// ---------------------------------------------------------------------------
#define ESTOP_DEBOUNCE_MS 30u
#define ESTOP_RESET_HOLD_MS 1000u  // reset button must be held this long

// ---------------------------------------------------------------------------
// Watchdog / buffers
// ---------------------------------------------------------------------------
// Must exceed the longest blocking network call (TLS handshake is bounded by
// TLS_HANDSHAKE_TIMEOUT_S). Pumps never depend on the loop to stop: the
// hardware timer and the e-stop ISR switch them off on their own.
#define WDT_TIMEOUT_S 10
#define COMMAND_RING_SIZE 16
#define OUTBOX_SIZE 24
#define INBOX_SIZE 4
#define DEVICE_SEQ_RESERVE_BLOCK 1000u  // NVS write once per this many events
