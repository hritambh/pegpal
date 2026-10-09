// PegPal controller firmware. UNTESTED ON HARDWARE.
//
// Setup order is a safety requirement: pump outputs are forced OFF before
// anything else (including Serial), then the e-stop, watchdog, scale, NVS and
// only then the network. The loop never blocks on pump timing; the hardware
// timer and the e-stop ISR stop pumps without it.
#include <Arduino.h>
#include <ArduinoJson.h>
#include <esp_system.h>
#include <esp_task_wdt.h>

#include "commands.h"
#include "config.h"
#include "console.h"
#include "dispenser.h"
#include "estop.h"
#include "events.h"
#include "link.h"
#include "pumps.h"
#include "scale.h"
#include "store.h"

namespace {

#if !PEGPAL_BENCH_MODE
uint32_t s_lastStatusMs = 0;

void sendStatus() {
  JsonDocument d;
  events::status(d);
  events::send(d);
  s_lastStatusMs = millis();
}
#endif

void reportBootFault() {
  esp_reset_reason_t rr = esp_reset_reason();
  bool wdt = rr == ESP_RST_TASK_WDT || rr == ESP_RST_INT_WDT || rr == ESP_RST_WDT || rr == ESP_RST_PANIC;
  if (!wdt) return;
  const char* inflight = commands::bootInFlightCommandId();
  JsonDocument d;
  events::fault(d, "WATCHDOG",
                rr == ESP_RST_PANIC ? "rebooted after a panic; all pumps off, nothing resumed"
                                    : "rebooted by watchdog; all pumps off, nothing resumed",
                inflight[0] ? inflight : nullptr);
  events::send(d);
}

void handleEstopEdges() {
  int edge = estop::consumeEdge();
  if (edge == 0) return;
  JsonDocument d;
  if (edge > 0) {
    String interrupted = dispenser::activeCommandId() ? dispenser::activeCommandId() : "";
    Serial.println("[estop] LATCHED");
    events::estop(d, true, interrupted.length() ? interrupted.c_str() : nullptr);
    events::send(d);
    if (dispenser::active()) dispenser::abort("ESTOP", "e-stop pressed during dispense");
  } else {
    Serial.println("[estop] cleared locally");
    events::estop(d, false, nullptr);
    events::send(d);
  }
}

}  // namespace

void setup() {
  // 1. Pumps: every output OFF, motor-enable relay OFF. Must be first.
  pumps::safeInit();

  Serial.begin(115200);
  Serial.printf("\nPegPal controller %s (UNTESTED ON HARDWARE)%s\n", FIRMWARE_VERSION,
                PEGPAL_BENCH_MODE ? " [BENCH MODE: no network]" : "");

  // 2. E-stop (latches at once if pressed at boot).
  estop::begin();

  // 3. Task watchdog on the loop task (Arduino core 2.x / IDF 4.4 API; panic = reset).
  esp_task_wdt_init(WDT_TIMEOUT_S, true);
  esp_task_wdt_add(nullptr);

  // 4. Scale hardware, 5. NVS (then apply the stored calibration).
  scale::begin({SCALE_DEFAULT_COUNTS_PER_G, 0, false});
  store::begin();
  scale::setCalibration(store::loadScaleCalibration());
  commands::begin();
  reportBootFault();

  // 6. Network last.
#if !PEGPAL_BENCH_MODE
  net::begin();
#endif
}

void loop() {
  esp_task_wdt_reset();

  estop::update();
  handleEstopEdges();

  scale::update();
  dispenser::update();
  commands::update();

#if !PEGPAL_BENCH_MODE
  // Link-loss safe stop.
  if (dispenser::active() && net::offlineMs() > LINK_LOSS_STOP_MS) {
    dispenser::abort("CONNECTION_LOST", "MQTT link lost during dispense; pump stopped");
  }

  // Invariant: no pump may be on unless a dispense step owns it.
  if (pumps::anyOn() && !dispenser::active()) {
    pumps::stopAll();
    JsonDocument d;
    events::fault(d, "PUMP_FAULT", "pump output on without an active dispense; forced off", nullptr);
    events::send(d);
  }

  net::update(pumps::anyOn());

  String msg;
  while (net::popInbound(msg)) commands::handleEnvelope(msg.c_str(), msg.length());

  if (net::consumeJustConnected()) sendStatus();
  // Periodic STATUS is deferred while a pump runs (a QoS 1 publish waits for PUBACK).
  if (net::connected() && !pumps::anyOn() && millis() - s_lastStatusMs >= STATUS_INTERVAL_MS) {
    sendStatus();
  }
#else
  if (pumps::anyOn() && !console::benchPumpActive()) pumps::stopAll();
#endif

  console::update();
}
