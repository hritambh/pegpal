// Pump outputs. At most one pump runs at a time. Every run is capped by a
// hardware timer whose ISR switches the outputs off without the main loop.
#pragma once

#include <Arduino.h>

namespace pumps {

// Drive every pump output to OFF and the motor-enable relay off. Call this
// first in setup(), before anything else.
void safeInit();

// Start one logical channel. Refuses if any pump is on, the channel is out of
// range/disabled, the e-stop is latched, or maxRuntimeMs is 0 or above
// FW_MAX_PUMP_RUNTIME_MS. The hardware timer is armed for maxRuntimeMs.
bool start(uint8_t channel, uint32_t maxRuntimeMs);

// Switch everything off (pump outputs and motor-enable relay). Safe to call any
// time from task context; idempotent.
void stopAll();

// ISR-safe variant: register writes only. Used by the e-stop ISR and the timer ISR.
void IRAM_ATTR stopAllFromIsr();

// Block start() until clearInhibit(). Set by the e-stop ISR.
void IRAM_ATTR inhibitFromIsr();
void clearInhibit();
bool inhibited();

bool anyOn();
int activeChannel();             // -1 when none
uint32_t runtimeMs();            // of the current or last run
bool consumeTimerTripped();      // true once after the hardware timer cut a run
bool allOutputsOffReadback();    // reads the GPIO output registers

}  // namespace pumps
