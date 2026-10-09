// Command intake: envelope verification, validation (docs/hardware-protocol.md
// "Controller-side validation"), idempotency ring, dispatch.
#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>

namespace commands {

// Reads the boot-time in-flight marker. Call after store::begin().
void begin();

// One raw envelope from the cmd topic.
void handleEnvelope(const char* data, size_t len);

// Tare completion and other deferred replies.
void update();

// Called by the dispenser with the step's final event body (not yet sent).
// Sends it, records it for duplicate replay, clears the in-flight marker.
void dispenseFinished(const char* commandId, const char* outcome, JsonDocument& body);

// STATUS fields
const char* lastCommandId();       // nullptr if none
const char* lastCommandOutcome();  // DONE | FAILED | STOPPED | NONE | UNKNOWN
bool bootedRecently();

// Boot-time in-flight command id (empty if none), for the boot FAULT event.
const char* bootInFlightCommandId();

}  // namespace commands
