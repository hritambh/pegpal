#include "estop.h"

#include <soc/gpio_struct.h>

#include "config.h"
#include "pumps.h"

namespace estop {
namespace {

DRAM_ATTR volatile bool s_latched = false;
DRAM_ATTR volatile bool s_latchEdge = false;  // set by ISR or poll
bool s_clearEdge = false;

uint32_t s_releasedSinceMs = 0;  // 0 = switch currently reads active
uint32_t s_resetHeldSinceMs = 0;
bool s_resetNeedsRelease = false;  // button must be released between resets

inline bool IRAM_ATTR switchActiveRaw() {
  uint32_t level = (ESTOP_PIN < 32) ? ((GPIO.in >> ESTOP_PIN) & 1u)
                                    : ((GPIO.in1.val >> (ESTOP_PIN - 32)) & 1u);
  return level == (uint32_t)ESTOP_ACTIVE_LEVEL;
}

void IRAM_ATTR onEstopEdge() {
  // Latch on any active reading. Noise can only make this MORE conservative.
  if (switchActiveRaw()) {
    pumps::inhibitFromIsr();
    pumps::stopAllFromIsr();
    if (!s_latched) {
      s_latched = true;
      s_latchEdge = true;
    }
  }
}

void latchFromTask() {
  pumps::inhibitFromIsr();
  pumps::stopAll();
  if (!s_latched) {
    s_latched = true;
    s_latchEdge = true;
  }
}

}  // namespace

void begin() {
  // GPIO34..39 have no internal pull-ups; an external pull-up is required there.
  pinMode(ESTOP_PIN, ESTOP_PIN >= 34 ? INPUT : INPUT_PULLUP);
  pinMode(ESTOP_RESET_PIN, ESTOP_RESET_PIN >= 34 ? INPUT : INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(ESTOP_PIN), onEstopEdge, CHANGE);
  if (switchActiveRaw()) latchFromTask();
}

void update() {
  uint32_t now = millis();
  bool active = switchActiveRaw();

  // Polling backs up the ISR (missed edge, noisy input).
  if (active) {
    latchFromTask();
    s_releasedSinceMs = 0;
    s_resetHeldSinceMs = 0;
    return;
  }
  if (s_releasedSinceMs == 0) s_releasedSinceMs = now ? now : 1;

  if (!s_latched) return;

  // Keep forcing outputs off while latched, whatever else the loop does.
  if (pumps::anyOn()) pumps::stopAll();

  bool resetPressed = digitalRead(ESTOP_RESET_PIN) == ESTOP_RESET_ACTIVE_LEVEL;
  if (!resetPressed) {
    s_resetHeldSinceMs = 0;
    s_resetNeedsRelease = false;
    return;
  }
  if (s_resetNeedsRelease) return;
  if (s_resetHeldSinceMs == 0) s_resetHeldSinceMs = now ? now : 1;

  bool switchReleasedLongEnough = (now - s_releasedSinceMs) >= ESTOP_DEBOUNCE_MS;
  bool heldLongEnough = (now - s_resetHeldSinceMs) >= ESTOP_RESET_HOLD_MS;
  if (switchReleasedLongEnough && heldLongEnough && !switchActiveRaw()) {
    s_latched = false;
    pumps::clearInhibit();
    s_clearEdge = true;
    s_resetNeedsRelease = true;
    s_resetHeldSinceMs = 0;
  }
}

bool latched() { return s_latched; }

int consumeEdge() {
  if (s_latchEdge) {
    s_latchEdge = false;
    s_clearEdge = false;  // a new latch supersedes a pending clear
    return 1;
  }
  if (s_clearEdge) {
    s_clearEdge = false;
    return -1;
  }
  return 0;
}

}  // namespace estop
