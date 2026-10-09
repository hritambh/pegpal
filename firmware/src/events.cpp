#include "events.h"

#include <math.h>

#include "commands.h"
#include "config.h"
#include "dispenser.h"
#include "estop.h"
#include "link.h"
#include "protocol.h"
#include "pumps.h"
#include "scale.h"

namespace events {
namespace {

float round1(float v) { return roundf(v * 10.0f) / 10.0f; }

void setOpt(JsonDocument& d, const char* key, OptF o) {
  if (o.has && isfinite(o.v)) d[key] = round1(o.v); else d[key] = nullptr;
}
void setOpt(JsonDocument& d, const char* key, OptU o) {
  if (o.has) d[key] = o.v; else d[key] = nullptr;
}
void setStr(JsonDocument& d, const char* key, const char* s) {
  if (s && s[0]) d[key] = s; else d[key] = nullptr;
}

}  // namespace

void ack(JsonDocument& d, const char* commandId, bool accepted, const char* reason, bool duplicate) {
  d["type"] = "ACK";
  d["commandId"] = commandId;
  d["accepted"] = accepted;
  if (reason && reason[0]) d["reason"] = reason;
  if (duplicate) d["duplicate"] = true;
}

void progress(JsonDocument& d, const char* commandId, uint32_t elapsedMs, OptF estimatedMl, OptF massG) {
  d["type"] = "PROGRESS";
  d["commandId"] = commandId;
  d["elapsedMs"] = elapsedMs;
  setOpt(d, "estimatedMl", estimatedMl);
  setOpt(d, "massG", massG);
}

void done(JsonDocument& d, const char* commandId, uint32_t runtimeMs, OptF massDeltaG, bool massStableKnown,
          bool massStable) {
  d["type"] = "DONE";
  d["commandId"] = commandId;
  d["runtimeMs"] = runtimeMs;
  setOpt(d, "massDeltaG", massDeltaG);
  if (massStableKnown) d["massStable"] = massStable; else d["massStable"] = nullptr;
}

void failed(JsonDocument& d, const char* commandId, const char* code, const char* message, OptU runtimeMs,
            OptF massDeltaG) {
  d["type"] = "FAILED";
  d["commandId"] = commandId;
  d["code"] = code;
  d["message"] = message;
  setOpt(d, "runtimeMs", runtimeMs);
  setOpt(d, "massDeltaG", massDeltaG);
}

void stopped(JsonDocument& d, const char* commandId, const char* interruptedOrNull, OptU runtimeMs,
             OptF massDeltaG, bool allPumpsOff) {
  d["type"] = "STOPPED";
  d["commandId"] = commandId;
  setStr(d, "interruptedCommandId", interruptedOrNull);
  setOpt(d, "runtimeMs", runtimeMs);
  setOpt(d, "massDeltaG", massDeltaG);
  d["allPumpsOff"] = allPumpsOff;
}

void tareDone(JsonDocument& d, const char* commandId, bool ok, bool stable, OptF platformMassG,
              const char* reasonOrNull) {
  d["type"] = "TARE_DONE";
  d["commandId"] = commandId;
  d["ok"] = ok;
  d["stable"] = stable;
  setOpt(d, "platformMassG", platformMassG);
  if (reasonOrNull && reasonOrNull[0]) d["reason"] = reasonOrNull;
}

void estop(JsonDocument& d, bool active, const char* interruptedOrNull) {
  d["type"] = "ESTOP";
  d["active"] = active;
  setStr(d, "interruptedCommandId", interruptedOrNull);
}

void fault(JsonDocument& d, const char* code, const char* message, const char* interruptedOrNull) {
  d["type"] = "FAULT";
  d["code"] = code;
  d["message"] = message;
  setStr(d, "interruptedCommandId", interruptedOrNull);
}

void status(JsonDocument& d) {
  d["type"] = "STATUS";
  d["firmwareVersion"] = FIRMWARE_VERSION;
  d["estopActive"] = ::estop::latched();
  d["anyPumpOn"] = pumps::anyOn();
  setStr(d, "activeCommandId", dispenser::activeCommandId());
  setStr(d, "lastCommandId", commands::lastCommandId());
  d["lastCommandOutcome"] = commands::lastCommandOutcome();
  d["scaleOk"] = scale::healthy();
  d["bootedRecently"] = commands::bootedRecently();
}

void send(JsonDocument& body, Delivery delivery) {
  String envelope = protocol::finalizeEvent(body);
  net::enqueue(envelope, delivery == Delivery::RELIABLE);
}

}  // namespace events
