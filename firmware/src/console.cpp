#include "console.h"

#include <Arduino.h>
#include <math.h>

#include "config.h"
#include "dispenser.h"
#include "estop.h"
#include "pumps.h"
#include "scale.h"
#include "store.h"

namespace console {
namespace {

char s_line[64];
size_t s_len = 0;
bool s_benchPump = false;

void show() {
  const scale::Calibration& c = scale::calibration();
  bool pv, tv;
  float p = scale::platformMassG(&pv);
  float t = scale::massSinceTareG(&tv);
  Serial.printf("cal: countsPerG=%.4f emptyRaw=%ld emptyValid=%d\n", c.countsPerG, (long)c.emptyRaw,
                (int)c.emptyValid);
  Serial.printf("scale: healthy=%d primed=%d stable=%d filteredRaw=%.1f\n", (int)scale::healthy(),
                (int)scale::primed(), (int)scale::stable(), scale::filteredRaw());
  if (pv) Serial.printf("platformMassG=%.1f\n", p); else Serial.println("platformMassG=n/a (run 'zero')");
  if (tv) Serial.printf("massSinceTareG=%.1f\n", t);
  Serial.printf("estop=%d anyPumpOn=%d\n", (int)estop::latched(), (int)pumps::anyOn());
}

bool readyForCal() {
  if (dispenser::active() || pumps::anyOn()) {
    Serial.println("refused: pump/dispense active");
    return false;
  }
  if (!scale::healthy() || !scale::stable()) {
    Serial.println("refused: scale not healthy and stable; wait and retry");
    return false;
  }
  return true;
}

void handle(char* line) {
  char* cmd = strtok(line, " ");
  if (!cmd) return;
  if (!strcmp(cmd, "show")) return show();
  if (!strcmp(cmd, "zero")) {
    if (!readyForCal()) return;
    scale::Calibration c = scale::calibration();
    c.emptyRaw = (int32_t)lroundf(scale::filteredRaw());
    c.emptyValid = true;
    scale::setCalibration(c);
    store::saveScaleCalibration(c);
    Serial.printf("empty baseline saved: %ld\n", (long)c.emptyRaw);
    return;
  }
  if (!strcmp(cmd, "cal")) {
    char* arg = strtok(nullptr, " ");
    float grams = arg ? atof(arg) : 0;
    if (grams < 10) {
      Serial.println("usage: cal <grams>  (reference mass >= 10 g; run 'zero' first, empty)");
      return;
    }
    if (!readyForCal()) return;
    scale::Calibration c = scale::calibration();
    if (!c.emptyValid) {
      Serial.println("refused: run 'zero' with the platform empty first");
      return;
    }
    float cpg = (scale::filteredRaw() - (float)c.emptyRaw) / grams;
    if (fabsf(cpg) < 1.0f) {
      Serial.println("refused: almost no change in counts; is the mass on the platform?");
      return;
    }
    c.countsPerG = cpg;
    scale::setCalibration(c);
    store::saveScaleCalibration(c);
    Serial.printf("countsPerG saved: %.4f (also copy into SCALE_DEFAULT_COUNTS_PER_G)\n", cpg);
    return;
  }
#if PEGPAL_BENCH_MODE
  if (!strcmp(cmd, "pump")) {
    char* a = strtok(nullptr, " ");
    char* b = strtok(nullptr, " ");
    if (!a || !b) return (void)Serial.println("usage: pump <ch> <ms>");
    int ch = atoi(a);
    long ms = atol(b);
    if (ch < 0 || ms <= 0) return (void)Serial.println("bad args");
    // pumps::start enforces channel range/mask, FW_MAX_PUMP_RUNTIME_MS and e-stop.
    if (pumps::start((uint8_t)ch, (uint32_t)ms)) {
      s_benchPump = true;
      Serial.printf("pump %d on for up to %ld ms (hardware timer)\n", ch, ms);
    } else {
      Serial.println("refused (busy, disabled channel, limit or e-stop)");
    }
    return;
  }
  if (!strcmp(cmd, "stop")) {
    pumps::stopAll();
    s_benchPump = false;
    Serial.println("all off");
    return;
  }
#endif
  Serial.println("commands: show | zero | cal <grams>"
#if PEGPAL_BENCH_MODE
                 " | pump <ch> <ms> | stop"
#endif
  );
}

}  // namespace

void update() {
  if (s_benchPump && !pumps::anyOn()) {
    s_benchPump = false;
    Serial.printf("pump off after %lu ms%s\n", (unsigned long)pumps::runtimeMs(),
                  pumps::consumeTimerTripped() ? " (hardware timer)" : "");
  }
  while (Serial.available()) {
    int c = Serial.read();
    if (c == '\r') continue;
    if (c == '\n') {
      s_line[s_len] = 0;
      s_len = 0;
      handle(s_line);
      continue;
    }
    if (s_len < sizeof(s_line) - 1) s_line[s_len++] = (char)c;
  }
}

bool benchPumpActive() { return s_benchPump; }

}  // namespace console
