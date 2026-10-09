// NVS persistence (Preferences): command seq, deviceSeq, in-flight marker,
// scale calibration.
#pragma once

#include <Arduino.h>

#include "scale.h"

namespace store {

void begin();  // opens NVS; resets deviceSeq if the HMAC keyId changed

// Highest command seq accepted so far. Written on every advance.
uint32_t lastSeq();
void setLastSeq(uint32_t seq);

// Strictly increasing across reboots. NVS holds a reserved high-water mark that
// is bumped every DEVICE_SEQ_RESERVE_BLOCK events, so a reboot skips ahead
// instead of reusing numbers.
uint32_t nextDeviceSeq();

// In-flight marker: set before a pump starts, cleared once the step's final
// event exists. Found set at boot = outcome UNKNOWN.
void setInFlight(const char* commandId);
void clearInFlight();
// Read once at boot (before any setInFlight). Empty string = none.
String bootInFlight();

scale::Calibration loadScaleCalibration();
void saveScaleCalibration(const scale::Calibration& cal);

}  // namespace store
