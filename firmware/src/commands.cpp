#include "commands.h"

#include <math.h>
#include <string.h>

#include "config.h"
#include "dispenser.h"
#include "estop.h"
#include "events.h"
#include "protocol.h"
#include "pumps.h"
#include "scale.h"
#include "secrets.h"
#include "store.h"

namespace commands {
namespace {

constexpr size_t kIdMax = 64;

enum class Kind : uint8_t { DISPENSE, STOP, TARE, STATUS_REQUEST, UNKNOWN };

struct Entry {
  bool used;
  char commandId[kIdMax + 1];
  Kind kind;
  bool accepted;
  char reason[32];
  bool finished;
  String finalBody;  // type-specific JSON body of the final event ("" = ACK was final)
};

Entry s_ring[COMMAND_RING_SIZE];
int s_ringNext = 0;

char s_lastCommandId[kIdMax + 1] = "";
const char* s_lastOutcome = "NONE";
bool s_bootedRecently = true;
char s_bootInFlight[kIdMax + 1] = "";

// TARE in progress
bool s_tarePending = false;
char s_tareCommandId[kIdMax + 1];

Entry* find(const char* id) {
  for (auto& e : s_ring) {
    if (e.used && strcmp(e.commandId, id) == 0) return &e;
  }
  return nullptr;
}

Entry* record(const char* id, Kind kind, bool accepted, const char* reason, bool finished) {
  // Never evict a command that is still running (its final event must be stored).
  for (int i = 0; i < COMMAND_RING_SIZE; i++) {
    Entry& c = s_ring[s_ringNext];
    if (!(c.used && !c.finished)) break;
    s_ringNext = (s_ringNext + 1) % COMMAND_RING_SIZE;
  }
  Entry& e = s_ring[s_ringNext];
  s_ringNext = (s_ringNext + 1) % COMMAND_RING_SIZE;
  e.used = true;
  strlcpy(e.commandId, id, sizeof(e.commandId));
  e.kind = kind;
  e.accepted = accepted;
  strlcpy(e.reason, reason ? reason : "", sizeof(e.reason));
  e.finished = finished;
  e.finalBody = "";
  return &e;
}

void sendAck(const char* id, bool accepted, const char* reason, bool duplicate) {
  JsonDocument d;
  events::ack(d, id, accepted, reason, duplicate);
  events::send(d);
}

void reject(const char* id, Kind kind, const char* reason) {
  Serial.printf("[cmd] reject %s: %s\n", id, reason);
  record(id, kind, false, reason, true);
  sendAck(id, false, reason, false);
}

// Send a final body and store a copy for duplicate replay.
void sendFinal(Entry* e, JsonDocument& body) {
  String copy;
  serializeJson(body, copy);
  if (e) {
    e->finished = true;
    e->finalBody = copy;
  }
  events::send(body);
}

void replayBody(const String& body) {
  JsonDocument d;
  if (deserializeJson(d, body) != DeserializationError::Ok) return;
  events::send(d);  // fresh eventId/deviceSeq: a re-delivery, not a byte copy
}

void sendStatus() {
  JsonDocument d;
  events::status(d);
  events::send(d);
}

Kind kindOf(const char* t) {
  if (!t) return Kind::UNKNOWN;
  if (!strcmp(t, "DISPENSE")) return Kind::DISPENSE;
  if (!strcmp(t, "STOP")) return Kind::STOP;
  if (!strcmp(t, "TARE")) return Kind::TARE;
  if (!strcmp(t, "STATUS_REQUEST")) return Kind::STATUS_REQUEST;
  return Kind::UNKNOWN;
}

bool isNullableString(JsonVariantConst v) { return v.isNull() || v.is<const char*>(); }
bool isUInt(JsonVariantConst v) {
  if (!v.is<double>()) return false;
  double d = v.as<double>();
  return d >= 0 && d <= 4294967295.0 && floor(d) == d;
}
bool isFiniteNum(JsonVariantConst v) { return v.is<double>() && isfinite(v.as<double>()); }

// ---------------------------------------------------------------------------

void handleStop(const char* id, JsonDocument& cmd, Entry* dup) {
  // Always stop first, whatever else happens. Re-stopping is harmless.
  dispenser::StopResult r = dispenser::stopForCommand();
  pumps::stopAll();
  bool off = pumps::allOutputsOffReadback();

  if (dup) {
    sendAck(id, true, nullptr, true);
    if (dup->finished && dup->finalBody.length()) replayBody(dup->finalBody);
    return;
  }
  Entry* e = record(id, Kind::STOP, true, nullptr, false);
  sendAck(id, true, nullptr, false);

  JsonDocument d;
  events::stopped(d, id, r.interrupted ? r.interruptedCommandId.c_str() : nullptr,
                  r.runtimeKnown ? events::someU(r.runtimeMs) : events::noneU(),
                  r.massKnown ? events::someF(r.massDeltaG) : events::none(), off);
  if (r.interrupted) {
    // The interrupted DISPENSE's final event is this STOPPED.
    Entry* de = find(r.interruptedCommandId.c_str());
    String copy;
    serializeJson(d, copy);
    if (de) {
      de->finished = true;
      de->finalBody = copy;
    }
    strlcpy(s_lastCommandId, r.interruptedCommandId.c_str(), sizeof(s_lastCommandId));
    s_lastOutcome = "STOPPED";
    store::clearInFlight();
  }
  sendFinal(e, d);
}

void handleTare(const char* id, JsonDocument& cmd) {
  JsonVariantConst orderId = cmd["orderId"];
  if (!isNullableString(orderId)) return reject(id, Kind::TARE, "INVALID_COMMAND");
  if (dispenser::active() || s_tarePending) return reject(id, Kind::TARE, "BUSY");

  Entry* e = record(id, Kind::TARE, true, nullptr, false);
  sendAck(id, true, nullptr, false);
  if (!scale::healthy()) {
    JsonDocument d;
    events::tareDone(d, id, false, false, events::none(), "SCALE_FAULT");
    return sendFinal(e, d);
  }
  scale::startTare(orderId.isNull() ? nullptr : orderId.as<const char*>());
  s_tarePending = true;
  strlcpy(s_tareCommandId, id, sizeof(s_tareCommandId));
}

void handleDispense(const char* id, JsonDocument& cmd) {
  const Kind K = Kind::DISPENSE;
  JsonVariantConst orderId = cmd["orderId"];
  const char* purpose = cmd["purpose"].is<const char*>() ? cmd["purpose"].as<const char*>() : "";
  const char* strategy = cmd["strategy"].is<const char*>() ? cmd["strategy"].as<const char*>() : "";
  bool isOrder = !strcmp(purpose, "ORDER");
  bool isWeight = !strcmp(strategy, "WEIGHT");

  // --- structure ---
  if (!isNullableString(orderId) || (orderId.is<const char*>() && strlen(orderId.as<const char*>()) > kIdMax))
    return reject(id, K, "INVALID_COMMAND");
  if (!isOrder && strcmp(purpose, "CALIBRATION")) return reject(id, K, "INVALID_COMMAND");
  if (isOrder && orderId.isNull()) return reject(id, K, "INVALID_COMMAND");
  if (!isWeight && strcmp(strategy, "TIMED")) return reject(id, K, "INVALID_COMMAND");
  if (!cmd["channel"].is<int>()) return reject(id, K, "INVALID_COMMAND");
  if (!isFiniteNum(cmd["targetMl"]) || cmd["targetMl"].as<double>() <= 0) return reject(id, K, "INVALID_COMMAND");
  if (!isUInt(cmd["maxDurationMs"]) || cmd["maxDurationMs"].as<double>() == 0) return reject(id, K, "INVALID_COMMAND");
  if (!isWeight) {
    if (!isUInt(cmd["runtimeMs"]) || cmd["runtimeMs"].as<double>() < FW_MIN_RUNTIME_MS)
      return reject(id, K, "INVALID_COMMAND");
  } else {
    if (!isFiniteNum(cmd["targetMassG"]) || cmd["targetMassG"].as<double>() <= 0) return reject(id, K, "INVALID_COMMAND");
    if (!isFiniteNum(cmd["cutoffMarginG"]) || cmd["cutoffMarginG"].as<double>() < 0 ||
        cmd["cutoffMarginG"].as<double>() >= cmd["targetMassG"].as<double>())
      return reject(id, K, "INVALID_COMMAND");
  }

  // --- time (spec: reject if synced and too old; this build also requires sync) ---
  uint64_t nowMs;
  bool synced = protocol::epochMs(&nowMs);
  if (!synced && REQUIRE_TIME_SYNC_FOR_DISPENSE) return reject(id, K, "INVALID_COMMAND");
  if (synced) {
    double issuedAt = cmd["issuedAt"].as<double>();
    double now = (double)nowMs;
    if (now - issuedAt > (double)COMMAND_MAX_AGE_MS) return reject(id, K, "STALE_SEQUENCE");
    if (issuedAt - now > (double)COMMAND_MAX_FUTURE_SKEW_MS) return reject(id, K, "STALE_SEQUENCE");
  }

  // --- limits (compile-time; never from the network) ---
  int channel = cmd["channel"].as<int>();
  if (channel < 0 || channel >= PUMP_CHANNEL_COUNT) return reject(id, K, "INVALID_COMMAND");
  if (!(ENABLED_CHANNEL_MASK & (1u << channel))) return reject(id, K, "CHANNEL_DISABLED");
  float targetMl = cmd["targetMl"].as<float>();
  if (targetMl > FW_MAX_ML_PER_DISPENSE) return reject(id, K, "LIMIT_EXCEEDED");
  uint32_t maxDurationMs = cmd["maxDurationMs"].as<uint32_t>();
  if (maxDurationMs > FW_MAX_PUMP_RUNTIME_MS) return reject(id, K, "LIMIT_EXCEEDED");
  uint32_t runtimeMs = isWeight ? 0 : cmd["runtimeMs"].as<uint32_t>();
  if (!isWeight && runtimeMs > maxDurationMs) return reject(id, K, "LIMIT_EXCEEDED");
  float targetMassG = isWeight ? cmd["targetMassG"].as<float>() : 0;
  if (isWeight && targetMassG > FW_MAX_ML_PER_DISPENSE * FW_MAX_DENSITY_G_PER_ML)
    return reject(id, K, "LIMIT_EXCEEDED");

  // --- state ---
  if (dispenser::active() || pumps::anyOn()) return reject(id, K, "BUSY");
  if (estop::latched() || pumps::inhibited()) return reject(id, K, "ESTOP");
  const char* oid = orderId.isNull() ? nullptr : orderId.as<const char*>();
  if (isWeight) {
    if (!scale::healthy()) return reject(id, K, "SCALE_FAULT");
    if (!scale::tareValidFor(oid)) return reject(id, K, "INVALID_COMMAND");
  }

  dispenser::Request req;
  memset(&req, 0, sizeof(req));
  strlcpy(req.commandId, id, sizeof(req.commandId));
  req.orderIdNull = (oid == nullptr);
  if (oid) strlcpy(req.orderId, oid, sizeof(req.orderId));
  req.channel = (uint8_t)channel;
  req.weight = isWeight;
  req.targetMl = targetMl;
  req.runtimeMs = runtimeMs;
  req.targetMassG = targetMassG;
  req.cutoffMarginG = isWeight ? cmd["cutoffMarginG"].as<float>() : 0;
  req.maxDurationMs = maxDurationMs;

  // Persist the in-flight marker BEFORE anything can move.
  store::setInFlight(id);
  record(id, K, true, nullptr, false);
  sendAck(id, true, nullptr, false);
  if (!dispenser::begin(req)) {
    // Unreachable (checked above), but never leave a recorded command dangling.
    store::clearInFlight();
    JsonDocument d;
    events::failed(d, id, "BUSY", "dispenser busy", events::someU(0), events::none());
    sendFinal(find(id), d);
  }
}

}  // namespace

void begin() {
  String inflight = store::bootInFlight();
  if (inflight.length()) {
    strlcpy(s_bootInFlight, inflight.c_str(), sizeof(s_bootInFlight));
    strlcpy(s_lastCommandId, inflight.c_str(), sizeof(s_lastCommandId));
    s_lastOutcome = "UNKNOWN";
    store::clearInFlight();  // reported once via STATUS/FAULT; never resumed
  }
}

void handleEnvelope(const char* data, size_t len) {
  String payload;
  protocol::OpenResult r = protocol::openEnvelope(data, len, payload);
  if (r != protocol::OpenResult::OK) {
    // Security event: logged locally, no ACK.
    Serial.printf("[sec] dropped envelope: %s\n",
                  r == protocol::OpenResult::MALFORMED     ? "malformed"
                  : r == protocol::OpenResult::UNKNOWN_KEY ? "unknown keyId"
                                                           : "bad signature");
    return;
  }

  JsonDocument cmd;
  if (deserializeJson(cmd, payload) != DeserializationError::Ok) {
    Serial.println("[cmd] signed payload is not JSON; dropped");
    return;
  }
  const char* machineId = cmd["machineId"].is<const char*>() ? cmd["machineId"].as<const char*>() : "";
  if (strcmp(machineId, MACHINE_ID) != 0) {
    Serial.println("[sec] machineId mismatch; dropped");
    return;
  }
  if (!cmd["commandId"].is<const char*>()) {
    Serial.println("[cmd] no commandId; dropped");
    return;
  }
  const char* id = cmd["commandId"];
  size_t idLen = strlen(id);
  if (idLen == 0 || idLen > kIdMax) {
    Serial.println("[cmd] bad commandId length; dropped");
    return;
  }

  Kind kind = kindOf(cmd["type"].is<const char*>() ? cmd["type"].as<const char*>() : nullptr);
  Entry* dup = find(id);

  // STOP is never rejected for sequencing and always stops the pumps.
  if (kind == Kind::STOP) {
    if (isUInt(cmd["seq"])) store::setLastSeq(cmd["seq"].as<uint32_t>());
    return handleStop(id, cmd, dup);
  }

  if (dup) {
    sendAck(id, dup->accepted, dup->reason[0] ? dup->reason : nullptr, true);
    if (dup->kind == Kind::STATUS_REQUEST) {
      sendStatus();  // a status replay should be current, not stored
    } else if (dup->finished && dup->finalBody.length()) {
      replayBody(dup->finalBody);
    }
    return;
  }

  if (cmd["v"].as<int>() != PROTOCOL_VERSION || kind == Kind::UNKNOWN || !isUInt(cmd["seq"]) ||
      !cmd["issuedAt"].is<double>()) {
    return reject(id, kind, "INVALID_COMMAND");
  }
  uint32_t seq = cmd["seq"].as<uint32_t>();
  if (seq <= store::lastSeq()) return reject(id, kind, "STALE_SEQUENCE");
  store::setLastSeq(seq);

  switch (kind) {
    case Kind::DISPENSE: return handleDispense(id, cmd);
    case Kind::TARE: return handleTare(id, cmd);
    case Kind::STATUS_REQUEST: {
      Entry* e = record(id, kind, true, nullptr, true);
      (void)e;
      sendAck(id, true, nullptr, false);
      sendStatus();
      // The backend asked and will see this STATUS; clear the reboot flag.
      s_bootedRecently = false;
      return;
    }
    default: return;
  }
}

void update() {
  if (!s_tarePending) return;
  scale::TareState st = scale::tareState();
  if (st == scale::TareState::RUNNING) return;
  s_tarePending = false;
  bool ok = st == scale::TareState::OK;
  bool known;
  float p = scale::platformMassG(&known);
  JsonDocument d;
  events::tareDone(d, s_tareCommandId, ok, ok || scale::stable(),
                   known ? events::someF(p) : events::none(),
                   ok ? nullptr : (st == scale::TareState::FAULT ? "SCALE_FAULT" : "SCALE_UNSTABLE"));
  sendFinal(find(s_tareCommandId), d);
}

void dispenseFinished(const char* commandId, const char* outcome, JsonDocument& body) {
  strlcpy(s_lastCommandId, commandId, sizeof(s_lastCommandId));
  s_lastOutcome = outcome;
  store::clearInFlight();
  sendFinal(find(commandId), body);
}

const char* lastCommandId() { return s_lastCommandId[0] ? s_lastCommandId : nullptr; }
const char* lastCommandOutcome() { return s_lastOutcome; }
bool bootedRecently() { return s_bootedRecently; }
const char* bootInFlightCommandId() { return s_bootInFlight; }

}  // namespace commands
