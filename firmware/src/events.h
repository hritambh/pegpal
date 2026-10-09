// Event builders (field names follow packages/shared/src/protocol.ts) and the
// single send path: finalize (base fields + signature) and hand to the link.
//
// Builders return only the type-specific body. The command ring stores that
// body, so a duplicate replay goes out with a fresh eventId/deviceSeq.
#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>

namespace events {

// Optional numeric/string values map to JSON null when absent.
struct OptF { bool has; float v; };
struct OptU { bool has; uint32_t v; };
inline OptF none() { return {false, 0}; }
inline OptF someF(float v) { return {true, v}; }
inline OptU noneU() { return {false, 0}; }
inline OptU someU(uint32_t v) { return {true, v}; }

void ack(JsonDocument& d, const char* commandId, bool accepted, const char* reason, bool duplicate);
void progress(JsonDocument& d, const char* commandId, uint32_t elapsedMs, OptF estimatedMl, OptF massG);
void done(JsonDocument& d, const char* commandId, uint32_t runtimeMs, OptF massDeltaG, bool massStableKnown,
          bool massStable);
void failed(JsonDocument& d, const char* commandId, const char* code, const char* message, OptU runtimeMs,
            OptF massDeltaG);
void stopped(JsonDocument& d, const char* commandId, const char* interruptedOrNull, OptU runtimeMs,
             OptF massDeltaG, bool allPumpsOff);
void tareDone(JsonDocument& d, const char* commandId, bool ok, bool stable, OptF platformMassG,
              const char* reasonOrNull);
void estop(JsonDocument& d, bool active, const char* interruptedOrNull);
void fault(JsonDocument& d, const char* code, const char* message, const char* interruptedOrNull);
void status(JsonDocument& d);

enum class Delivery : uint8_t {
  RELIABLE,    // QoS 1, kept in the outbox until the broker acknowledges it
  BEST_EFFORT  // QoS 0, dropped if offline (PROGRESS)
};

// Finalize, sign and enqueue.
void send(JsonDocument& body, Delivery delivery = Delivery::RELIABLE);

}  // namespace events
