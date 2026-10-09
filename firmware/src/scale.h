// HX711 load cell: non-blocking reads, median + moving-average filter,
// stability by window standard deviation, tare with timeout, glass detection
// against the empty-platform baseline.
#pragma once

#include <Arduino.h>

namespace scale {

struct Calibration {
  float countsPerG;      // signed; sign follows the load-cell wiring
  int32_t emptyRaw;      // filtered raw reading of the empty platform
  bool emptyValid;       // false until captured on the serial console
};

void begin(const Calibration& cal);
void update();  // call every loop; reads only when the HX711 is ready

// Health / filter state
bool healthy();         // samples arriving within SCALE_TIMEOUT_MS, not saturated, plausible
bool primed();          // filter windows full
bool stable();          // primed and window stddev < STABLE_STDDEV_G
uint32_t sampleCounter();  // increments once per filtered sample
float filteredRaw();

// Masses in grams
float relativeG(float fromRaw);           // filtered now minus a raw reference
float massSinceTareG(bool* valid);        // valid only after a successful tare
float platformMassG(bool* valid);         // relative to the empty baseline
bool glassPresent(bool* known);           // known=false when no baseline captured

// Gain rate over the last windowMs, g/s. Returns false if not enough history.
bool rateGPerS(uint32_t windowMs, float* out);

// Tare (non-blocking)
enum class TareState : uint8_t { IDLE, RUNNING, OK, UNSTABLE, FAULT };
bool startTare(const char* orderIdOrNull);  // false if already running
TareState tareState();                      // OK/UNSTABLE/FAULT stay until next start
bool tareValidFor(const char* orderIdOrNull);
void invalidateTare();

// Calibration (local serial console only)
const Calibration& calibration();
void setCalibration(const Calibration& cal);

}  // namespace scale
