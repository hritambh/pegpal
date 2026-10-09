// Non-blocking dispense state machine for one pump step.
//
//   PRE_SETTLE -> PUMPING -> POST_SETTLE -> (DONE | FAILED)
//
// massDeltaG = stable reading after - stable reading before. Faults stop the
// pump immediately; the hardware timer caps every run independently.
#pragma once

#include <Arduino.h>

namespace dispenser {

struct Request {
  char commandId[65];
  char orderId[65];
  bool orderIdNull;
  uint8_t channel;
  bool weight;           // false = TIMED
  float targetMl;
  uint32_t runtimeMs;    // TIMED
  float targetMassG;     // WEIGHT
  float cutoffMarginG;   // WEIGHT
  uint32_t maxDurationMs;
};

// Begin a validated request. Returns false if a step is already active.
bool begin(const Request& req);
void update();

bool active();                 // any state other than IDLE
const char* activeCommandId(); // nullptr when idle

// Immediate abort with FAILED <code> (e-stop, link loss, invariant breach).
void abort(const char* code, const char* message);

// STOP command. Pumps off now. If a step was pumping or about to pump it ends
// without its own final event (the caller sends STOPPED and records it). A step
// that was only settling after a normal end is finalized first with its own outcome.
struct StopResult {
  bool interrupted;
  String interruptedCommandId;
  bool runtimeKnown;
  uint32_t runtimeMs;
  bool massKnown;
  float massDeltaG;
};
StopResult stopForCommand();

}  // namespace dispenser
