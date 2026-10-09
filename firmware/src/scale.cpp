#include "scale.h"

#include <HX711.h>
#include <math.h>
#include <string.h>

#include "config.h"

namespace scale {
namespace {

constexpr int32_t kRawMax = 8388607;   // HX711 saturation (0x7FFFFF)
constexpr int32_t kRawMin = -8388608;  // 0x800000
constexpr int kHistory = 32;
constexpr int kPrimeSamples = SCALE_MEDIAN_WINDOW + SCALE_AVG_WINDOW - 1 + SCALE_STABLE_WINDOW - 1;

HX711 s_hx;
Calibration s_cal = {SCALE_DEFAULT_COUNTS_PER_G, 0, false};

int32_t s_raw[SCALE_MEDIAN_WINDOW];
float s_med[SCALE_AVG_WINDOW];
float s_win[SCALE_STABLE_WINDOW];
int s_rawIdx = 0, s_medIdx = 0, s_winIdx = 0;
int s_count = 0;  // samples since the last reset (capped)
float s_filtered = 0;
uint32_t s_counter = 0;
uint32_t s_lastSampleMs = 0;
bool s_saturated = false;
bool s_everSampled = false;

struct Hist { uint32_t ms; float raw; };
Hist s_hist[kHistory];
int s_histIdx = 0, s_histCount = 0;

TareState s_tareState = TareState::IDLE;
uint32_t s_tareDeadline = 0;
char s_tareOrderPending[64];
bool s_tareOrderPendingNull = true;
bool s_tareOk = false;
float s_tareRaw = 0;
uint32_t s_tareAtMs = 0;
char s_tareOrder[64];
bool s_tareOrderNull = true;

void resetFilter() {
  s_count = 0;
  s_rawIdx = s_medIdx = s_winIdx = 0;
  s_histIdx = s_histCount = 0;
}

float medianOfRaw() {
  int32_t tmp[SCALE_MEDIAN_WINDOW];
  memcpy(tmp, s_raw, sizeof(tmp));
  for (int i = 1; i < SCALE_MEDIAN_WINDOW; i++) {  // insertion sort, n = 5
    int32_t v = tmp[i];
    int j = i - 1;
    while (j >= 0 && tmp[j] > v) { tmp[j + 1] = tmp[j]; j--; }
    tmp[j + 1] = v;
  }
  return (float)tmp[SCALE_MEDIAN_WINDOW / 2];
}

void ingest(int32_t raw, uint32_t now) {
  s_lastSampleMs = now;
  s_everSampled = true;
  s_saturated = (raw >= kRawMax || raw <= kRawMin);
  if (s_saturated) {
    resetFilter();
    return;
  }
  s_raw[s_rawIdx] = raw;
  s_rawIdx = (s_rawIdx + 1) % SCALE_MEDIAN_WINDOW;
  if (s_count < kPrimeSamples) s_count++;
  if (s_count < SCALE_MEDIAN_WINDOW) return;

  s_med[s_medIdx] = medianOfRaw();
  s_medIdx = (s_medIdx + 1) % SCALE_AVG_WINDOW;
  if (s_count < SCALE_MEDIAN_WINDOW + SCALE_AVG_WINDOW - 1) return;

  float sum = 0;
  for (int i = 0; i < SCALE_AVG_WINDOW; i++) sum += s_med[i];
  s_filtered = sum / SCALE_AVG_WINDOW;
  s_win[s_winIdx] = s_filtered;
  s_winIdx = (s_winIdx + 1) % SCALE_STABLE_WINDOW;
  s_hist[s_histIdx] = {now, s_filtered};
  s_histIdx = (s_histIdx + 1) % kHistory;
  if (s_histCount < kHistory) s_histCount++;
  s_counter++;
}

bool sameOrder(const char* a, bool aNull, const char* b) {
  if (b == nullptr) return aNull;
  return !aNull && strcmp(a, b) == 0;
}

void copyOrder(char* dst, bool* dstNull, const char* src) {
  if (src == nullptr) {
    *dstNull = true;
    dst[0] = 0;
  } else {
    *dstNull = false;
    strlcpy(dst, src, 64);
  }
}

void updateTare(uint32_t now) {
  if (s_tareState != TareState::RUNNING) return;
  if (stable() && healthy()) {
    s_tareRaw = s_filtered;
    s_tareAtMs = now;
    s_tareOk = true;
    memcpy(s_tareOrder, s_tareOrderPending, sizeof(s_tareOrder));
    s_tareOrderNull = s_tareOrderPendingNull;
    s_tareState = TareState::OK;
  } else if ((int32_t)(now - s_tareDeadline) >= 0) {
    s_tareState = healthy() ? TareState::UNSTABLE : TareState::FAULT;
  }
}

}  // namespace

void begin(const Calibration& cal) {
  s_cal = cal;
  if (s_cal.countsPerG == 0 || isnan(s_cal.countsPerG)) s_cal.countsPerG = SCALE_DEFAULT_COUNTS_PER_G;
  s_hx.begin(HX711_DOUT_PIN, HX711_SCK_PIN, 128);
  s_lastSampleMs = millis();
  resetFilter();
}

void update() {
  uint32_t now = millis();
  // is_ready() is a single pin read; read() only runs when data is waiting,
  // so it never blocks on the library's wait loop.
  if (s_hx.is_ready()) {
    ingest((int32_t)s_hx.read(), now);
  } else if (now - s_lastSampleMs > SCALE_TIMEOUT_MS) {
    resetFilter();  // stale data must not be used after a dropout
  }
  updateTare(now);
}

bool healthy() {
  if (!s_everSampled || s_saturated) return false;
  if (millis() - s_lastSampleMs > SCALE_TIMEOUT_MS) return false;
  if (s_cal.emptyValid && primed()) {
    bool v;
    float p = platformMassG(&v);
    if (v && fabsf(p) > SCALE_MAX_PLATFORM_G) return false;
  }
  return true;
}

bool primed() { return s_count >= kPrimeSamples; }

bool stable() {
  if (!primed()) return false;
  float mean = 0;
  for (int i = 0; i < SCALE_STABLE_WINDOW; i++) mean += s_win[i];
  mean /= SCALE_STABLE_WINDOW;
  float var = 0;
  for (int i = 0; i < SCALE_STABLE_WINDOW; i++) {
    float d = s_win[i] - mean;
    var += d * d;
  }
  var /= SCALE_STABLE_WINDOW;
  float stddevG = sqrtf(var) / fabsf(s_cal.countsPerG);
  return stddevG < STABLE_STDDEV_G;
}

uint32_t sampleCounter() { return s_counter; }
float filteredRaw() { return s_filtered; }

float relativeG(float fromRaw) { return (s_filtered - fromRaw) / s_cal.countsPerG; }

float massSinceTareG(bool* valid) {
  *valid = s_tareOk && primed();
  return *valid ? relativeG(s_tareRaw) : 0.0f;
}

float platformMassG(bool* valid) {
  *valid = s_cal.emptyValid && primed();
  return *valid ? relativeG((float)s_cal.emptyRaw) : 0.0f;
}

bool glassPresent(bool* known) {
  bool v;
  float p = platformMassG(&v);
  *known = v;
  return v && p >= MIN_GLASS_MASS_G;
}

bool rateGPerS(uint32_t windowMs, float* out) {
  if (s_histCount < 2) return false;
  int newest = (s_histIdx - 1 + kHistory) % kHistory;
  uint32_t tNew = s_hist[newest].ms;
  // Walk back to the oldest sample still inside the window.
  int pick = -1;
  for (int k = 1; k < s_histCount; k++) {
    int i = (newest - k + kHistory) % kHistory;
    if (tNew - s_hist[i].ms > windowMs) break;
    pick = i;
  }
  if (pick < 0) return false;
  uint32_t dt = tNew - s_hist[pick].ms;
  if (dt < windowMs / 2) return false;  // not enough span yet
  *out = ((s_hist[newest].raw - s_hist[pick].raw) / s_cal.countsPerG) * 1000.0f / (float)dt;
  return true;
}

bool startTare(const char* orderIdOrNull) {
  if (s_tareState == TareState::RUNNING) return false;
  copyOrder(s_tareOrderPending, &s_tareOrderPendingNull, orderIdOrNull);
  s_tareOk = false;  // a new tare request invalidates the old one
  s_tareDeadline = millis() + TARE_TIMEOUT_MS;
  s_tareState = TareState::RUNNING;
  return true;
}

TareState tareState() { return s_tareState; }

bool tareValidFor(const char* orderIdOrNull) {
  if (!s_tareOk) return false;
  if (millis() - s_tareAtMs > TARE_VALID_MS) return false;
  return sameOrder(s_tareOrder, s_tareOrderNull, orderIdOrNull);
}

void invalidateTare() { s_tareOk = false; }

const Calibration& calibration() { return s_cal; }
void setCalibration(const Calibration& cal) {
  s_cal = cal;
  s_tareOk = false;
}

}  // namespace scale
