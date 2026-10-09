// E-stop status input. The physical switch breaks motor power on its own (see
// docs/safety.md); this module only latches the software state, forces every
// output off from the ISR and reports it.
//
// The latch clears only when the switch reads released AND the local reset
// button is held for ESTOP_RESET_HOLD_MS. There is deliberately no function
// for clearing it from a message.
#pragma once

#include <Arduino.h>

namespace estop {

void begin();  // latches immediately if the switch is already pressed at boot

// Debounce, poll (backs up the ISR), handle the local reset button.
void update();

bool latched();

// Edges since the last call: +1 latched, -1 cleared locally, 0 none.
int consumeEdge();

}  // namespace estop
