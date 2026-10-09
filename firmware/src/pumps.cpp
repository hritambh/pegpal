#include "pumps.h"

#include <esp_timer.h>
#include <soc/gpio_struct.h>

#include "config.h"

static_assert(sizeof(PUMP_PINS) / sizeof(PUMP_PINS[0]) == PUMP_CHANNEL_COUNT, "pin map size");
static_assert(FW_MAX_PUMP_RUNTIME_MS > 0 && FW_MAX_PUMP_RUNTIME_MS <= 120000u,
              "FW_MAX_PUMP_RUNTIME_MS out of sane range");

namespace pumps {
namespace {

// Masks for the "set" and "clear" registers. Kept in DRAM so ISRs can read them.
DRAM_ATTR volatile uint32_t s_offClr0 = 0;   // pins < 32 to clear for OFF
DRAM_ATTR volatile uint32_t s_offClr1 = 0;   // pins >= 32 to clear for OFF
DRAM_ATTR volatile uint32_t s_offSet0 = 0;   // pins < 32 to set for OFF
DRAM_ATTR volatile uint32_t s_offSet1 = 0;   // pins >= 32 to set for OFF
DRAM_ATTR volatile int8_t s_active = -1;
DRAM_ATTR volatile bool s_inhibit = false;
DRAM_ATTR volatile bool s_timerTripped = false;
DRAM_ATTR volatile int64_t s_startedUs = 0;
DRAM_ATTR volatile int64_t s_stoppedUs = 0;

hw_timer_t* s_timer = nullptr;
portMUX_TYPE s_mux = portMUX_INITIALIZER_UNLOCKED;

void addOffBit(uint8_t pin, int offLevel) {
  if (pin < 32) {
    if (offLevel) s_offSet0 |= (1UL << pin); else s_offClr0 |= (1UL << pin);
  } else {
    if (offLevel) s_offSet1 |= (1UL << (pin - 32)); else s_offClr1 |= (1UL << (pin - 32));
  }
}

void writePin(uint8_t pin, int level) { digitalWrite(pin, level ? HIGH : LOW); }

void IRAM_ATTR onTimer() {
  stopAllFromIsr();
  s_timerTripped = true;
}

}  // namespace

void IRAM_ATTR stopAllFromIsr() {
  // Pumps first, relay second. Plain register writes: safe in any ISR.
  GPIO.out_w1tc = s_offClr0;
  GPIO.out1_w1tc.val = s_offClr1;
  GPIO.out_w1ts = s_offSet0;
  GPIO.out1_w1ts.val = s_offSet1;
  if (s_active >= 0) {
    s_active = -1;
    s_stoppedUs = esp_timer_get_time();  // IRAM-safe
  }
}

void IRAM_ATTR inhibitFromIsr() { s_inhibit = true; }

void safeInit() {
  // Compute masks, then drive everything OFF before switching pins to outputs
  // (writing the level first avoids a glitch when the driver is enabled).
  for (uint8_t ch = 0; ch < PUMP_CHANNEL_COUNT; ch++) {
    addOffBit(PUMP_PINS[ch], PUMP_ON_LEVEL ? 0 : 1);
  }
  addOffBit(MOTOR_ENABLE_PIN, MOTOR_ENABLE_ON_LEVEL ? 0 : 1);

  for (uint8_t ch = 0; ch < PUMP_CHANNEL_COUNT; ch++) {
    writePin(PUMP_PINS[ch], !PUMP_ON_LEVEL);
    pinMode(PUMP_PINS[ch], OUTPUT);
    writePin(PUMP_PINS[ch], !PUMP_ON_LEVEL);
  }
  writePin(MOTOR_ENABLE_PIN, !MOTOR_ENABLE_ON_LEVEL);
  pinMode(MOTOR_ENABLE_PIN, OUTPUT);
  writePin(MOTOR_ENABLE_PIN, !MOTOR_ENABLE_ON_LEVEL);
  s_active = -1;

  // Timer 0, 80 MHz APB / 80 = 1 us ticks, one-shot alarm (Arduino core 2.x API).
  s_timer = timerBegin(0, 80, true);
  timerAttachInterrupt(s_timer, &onTimer, true);
  timerAlarmDisable(s_timer);
}

bool start(uint8_t channel, uint32_t maxRuntimeMs) {
  if (channel >= PUMP_CHANNEL_COUNT) return false;
  if (!(ENABLED_CHANNEL_MASK & (1u << channel))) return false;
  if (maxRuntimeMs == 0 || maxRuntimeMs > FW_MAX_PUMP_RUNTIME_MS) return false;
  if (s_timer == nullptr) return false;

  bool ok = false;
  portENTER_CRITICAL(&s_mux);
  if (!s_inhibit && s_active < 0) {
    s_timerTripped = false;
    s_active = (int8_t)channel;
    ok = true;
  }
  portEXIT_CRITICAL(&s_mux);
  if (!ok) return false;

  // Arm the hardware cap BEFORE energizing anything.
  timerAlarmDisable(s_timer);
  timerWrite(s_timer, 0);
  timerAlarmWrite(s_timer, (uint64_t)maxRuntimeMs * 1000ULL, false);
  timerAlarmEnable(s_timer);

  s_startedUs = esp_timer_get_time();
  s_stoppedUs = 0;
  // Re-check: an e-stop ISR may have fired between the critical section and here.
  if (s_inhibit || s_active != (int8_t)channel) {
    stopAll();
    return false;
  }
  writePin(MOTOR_ENABLE_PIN, MOTOR_ENABLE_ON_LEVEL);
  writePin(PUMP_PINS[channel], PUMP_ON_LEVEL);
  if (s_inhibit) {  // and once more after energizing
    stopAll();
    return false;
  }
  return true;
}

void stopAll() {
  portENTER_CRITICAL(&s_mux);
  stopAllFromIsr();
  portEXIT_CRITICAL(&s_mux);
  if (s_timer) timerAlarmDisable(s_timer);
  // Belt and braces through the normal driver as well.
  for (uint8_t ch = 0; ch < PUMP_CHANNEL_COUNT; ch++) writePin(PUMP_PINS[ch], !PUMP_ON_LEVEL);
  writePin(MOTOR_ENABLE_PIN, !MOTOR_ENABLE_ON_LEVEL);
}

void clearInhibit() { s_inhibit = false; }
bool inhibited() { return s_inhibit; }

bool anyOn() { return s_active >= 0 || !allOutputsOffReadback(); }
int activeChannel() { return s_active; }

uint32_t runtimeMs() {
  if (s_startedUs == 0) return 0;
  int64_t end = (s_active >= 0) ? esp_timer_get_time() : s_stoppedUs;
  if (end < s_startedUs) return 0;
  return (uint32_t)((end - s_startedUs) / 1000);
}

bool consumeTimerTripped() {
  if (!s_timerTripped) return false;
  s_timerTripped = false;
  return true;
}

bool allOutputsOffReadback() {
  uint32_t out0 = GPIO.out;
  uint32_t out1 = GPIO.out1.val;
  bool ok = ((out0 & s_offClr0) == 0) && ((out1 & s_offClr1) == 0) &&
            ((out0 & s_offSet0) == s_offSet0) && ((out1 & s_offSet1) == s_offSet1);
  return ok;
}

}  // namespace pumps
