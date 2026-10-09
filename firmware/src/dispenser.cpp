#include "dispenser.h"

#include <ArduinoJson.h>

#include "commands.h"
#include "config.h"
#include "estop.h"
#include "events.h"
#include "pumps.h"
#include "scale.h"

namespace dispenser {
namespace {

enum class State : uint8_t { IDLE, PRE_SETTLE, PUMPING, POST_SETTLE };

State s_state = State::IDLE;
Request s_req;
uint32_t s_stateSinceMs = 0;
uint32_t s_capMs = 0;
uint32_t s_lastProgressMs = 0;

bool s_scaleInUse = false;   // scale supervises this step
bool s_startValid = false;   // a stable "before" reading exists
float s_startRaw = 0;
float s_peakG = 0;
uint32_t s_lastSample = 0;

// Pending outcome while settling after the pump stopped.
bool s_pendingDone = false;
const char* s_pendingCode = nullptr;
String s_pendingMessage;

uint32_t capFor(const Request& r) {
  return r.maxDurationMs < FW_MAX_PUMP_RUNTIME_MS ? r.maxDurationMs : FW_MAX_PUMP_RUNTIME_MS;
}

events::OptF currentDelta() {
  if (!s_scaleInUse || !s_startValid || !scale::healthy() || !scale::primed()) return events::none();
  return events::someF(scale::relativeG(s_startRaw));
}

void toState(State s) {
  s_state = s;
  s_stateSinceMs = millis();
}

void finishFailed(const char* code, const char* message, bool pumpRan) {
  pumps::stopAll();
  JsonDocument d;
  events::failed(d, s_req.commandId, code, message,
                 pumpRan ? events::someU(pumps::runtimeMs()) : events::someU(0), currentDelta());
  toState(State::IDLE);
  commands::dispenseFinished(s_req.commandId, "FAILED", d);
}

void finishDone() {
  bool stableNow = s_scaleInUse && scale::healthy() && scale::stable();
  JsonDocument d;
  events::done(d, s_req.commandId, pumps::runtimeMs(), currentDelta(), s_scaleInUse, stableNow);
  toState(State::IDLE);
  commands::dispenseFinished(s_req.commandId, "DONE", d);
}

// Pump already off; settle the scale before reporting (if it is in use).
void endPumping(bool isDone, const char* code, const char* message) {
  pumps::stopAll();
  s_pendingDone = isDone;
  s_pendingCode = code;
  s_pendingMessage = message ? message : "";
  toState(State::POST_SETTLE);
}

void finalizePending() {
  if (s_pendingDone) finishDone();
  else finishFailed(s_pendingCode, s_pendingMessage.c_str(), true);
}

void startPump() {
  s_capMs = capFor(s_req);
  if (!pumps::start(s_req.channel, s_capMs)) {
    if (estop::latched() || pumps::inhibited()) finishFailed("ESTOP", "e-stop active", false);
    else finishFailed("PUMP_FAULT", "pump output refused to start", false);
    return;
  }
  s_peakG = 0;
  s_lastSample = scale::sampleCounter();
  s_lastProgressMs = 0;
  toState(State::PUMPING);
}

void updatePreSettle(uint32_t now) {
  if (estop::latched()) return finishFailed("ESTOP", "e-stop active", false);
  bool healthy = scale::healthy();
  if (s_req.weight && !healthy) return finishFailed("SCALE_FAULT", "scale not responding", false);

  if (healthy && scale::stable()) {
    bool known;
    bool glass = scale::glassPresent(&known);
    if (known && !glass) return finishFailed("NO_GLASS", "no glass on the platform", false);
    s_startRaw = scale::filteredRaw();
    s_startValid = true;
    s_scaleInUse = true;
    return startPump();
  }
  bool timedOut = now - s_stateSinceMs >= PRE_SETTLE_TIMEOUT_MS;
  if (s_req.weight) {
    if (timedOut) finishFailed("SCALE_UNSTABLE", "no stable reading before dispensing", false);
    return;
  }
  // TIMED: the scale is optional. Without a healthy scale, start straight away.
  if (!healthy || timedOut) {
    if (healthy) {
      bool known;
      bool glass = scale::glassPresent(&known);
      if (known && !glass) return finishFailed("NO_GLASS", "no glass on the platform", false);
    }
    s_startValid = false;
    s_scaleInUse = false;
    startPump();
  }
}

void sendProgress(uint32_t elapsed) {
  events::OptF est = events::none();
  if (!s_req.weight && s_req.runtimeMs > 0) {
    float frac = (float)elapsed / (float)s_req.runtimeMs;
    if (frac > 1) frac = 1;
    est = events::someF(s_req.targetMl * frac);
  }
  bool valid;
  float sinceTare = scale::massSinceTareG(&valid);
  events::OptF massG = (valid && s_scaleInUse) ? events::someF(sinceTare) : events::none();
  JsonDocument d;
  events::progress(d, s_req.commandId, elapsed, est, massG);
  events::send(d, events::Delivery::BEST_EFFORT);
}

void updatePumping(uint32_t now) {
  if (estop::latched()) return finishFailed("ESTOP", "e-stop pressed during dispense", true);

  uint32_t elapsed = pumps::runtimeMs();
  if (pumps::consumeTimerTripped()) {
    // Hardware cap fired. For a TIMED step whose plan equals the cap this is the
    // normal end; otherwise the software stop did not happen in time.
    if (!s_req.weight && s_req.runtimeMs >= s_capMs) return endPumping(true, nullptr, nullptr);
    return endPumping(false, "MAX_DURATION_EXCEEDED", "hardware runtime cap reached");
  }
  if (pumps::activeChannel() != (int)s_req.channel) {
    return finishFailed("PUMP_FAULT", "pump output switched off unexpectedly", true);
  }
  if (!s_req.weight && elapsed >= s_req.runtimeMs) return endPumping(true, nullptr, nullptr);
  if (elapsed >= s_capMs) return endPumping(false, "MAX_DURATION_EXCEEDED", "runtime cap reached");

  if (s_scaleInUse) {
    if (!scale::healthy()) return finishFailed("SCALE_FAULT", "scale stopped responding", true);
    uint32_t c = scale::sampleCounter();
    if (c != s_lastSample) {
      s_lastSample = c;
      float gain = scale::relativeG(s_startRaw);
      if (gain > s_peakG) s_peakG = gain;
      if (s_peakG - gain > MASS_DROP_FAULT_G) {
        return finishFailed("UNEXPECTED_MASS_CHANGE", "mass dropped (glass removed?)", true);
      }
      float rate;
      if (scale::rateGPerS(FLOW_RATE_WINDOW_MS, &rate) && rate > MAX_PLAUSIBLE_FLOW_G_PER_S) {
        return finishFailed("UNEXPECTED_MASS_CHANGE", "mass rising faster than any pump", true);
      }
      if (elapsed >= NO_FLOW_TIMEOUT_MS && s_peakG < NO_FLOW_MIN_GAIN_G) {
        return finishFailed("NO_FLOW_DETECTED", "no mass gain while pumping", true);
      }
      if (s_req.weight && gain >= s_req.targetMassG - s_req.cutoffMarginG) {
        return endPumping(true, nullptr, nullptr);
      }
    }
  }

  if (s_lastProgressMs == 0 || now - s_lastProgressMs >= PROGRESS_INTERVAL_MS) {
    s_lastProgressMs = now ? now : 1;
    sendProgress(elapsed);
  }
}

void updatePostSettle(uint32_t now) {
  if (pumps::anyOn()) pumps::stopAll();
  bool settled = !s_scaleInUse || !scale::healthy() || scale::stable();
  if (settled || now - s_stateSinceMs >= POST_SETTLE_TIMEOUT_MS) finalizePending();
}

}  // namespace

bool begin(const Request& req) {
  if (s_state != State::IDLE) return false;
  s_req = req;
  s_startValid = false;
  s_scaleInUse = req.weight;
  toState(State::PRE_SETTLE);
  return true;
}

void update() {
  uint32_t now = millis();
  switch (s_state) {
    case State::IDLE: return;
    case State::PRE_SETTLE: return updatePreSettle(now);
    case State::PUMPING: return updatePumping(now);
    case State::POST_SETTLE: return updatePostSettle(now);
  }
}

bool active() { return s_state != State::IDLE; }

const char* activeCommandId() { return s_state == State::IDLE ? nullptr : s_req.commandId; }

void abort(const char* code, const char* message) {
  if (s_state == State::IDLE) {
    pumps::stopAll();
    return;
  }
  if (s_state == State::POST_SETTLE) {
    // Pump already off after a normal or failed end: report that outcome.
    pumps::stopAll();
    finalizePending();
    return;
  }
  finishFailed(code, message, s_state != State::PRE_SETTLE);
}

StopResult stopForCommand() {
  pumps::stopAll();
  StopResult r{false, String(), false, 0, false, 0};
  if (s_state == State::IDLE) return r;
  if (s_state == State::POST_SETTLE) {
    // The pump had already finished; report that step truthfully first.
    finalizePending();
    return r;
  }
  bool ran = s_state == State::PUMPING;
  r.interrupted = true;
  r.interruptedCommandId = s_req.commandId;
  r.runtimeKnown = true;
  r.runtimeMs = ran ? pumps::runtimeMs() : 0;
  // massDeltaG is only reported if the reading is stable right now; it usually
  // is not immediately after stopping, so this is commonly null.
  if (ran && s_scaleInUse && s_startValid && scale::healthy() && scale::stable()) {
    r.massKnown = true;
    r.massDeltaG = scale::relativeG(s_startRaw);
  }
  toState(State::IDLE);
  return r;
}

}  // namespace dispenser
