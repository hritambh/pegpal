// Local USB serial console (115200 baud, newline-terminated).
//
// Always available (physical access only, never reachable from the network):
//   show            print calibration, filtered raw, masses, stability, health
//   zero            capture the EMPTY platform as the glass-detection baseline
//   cal <grams>     with a known reference mass on the platform, compute counts/g
// Bench build only (PEGPAL_BENCH_MODE, no network):
//   pump <ch> <ms>  run one channel (all firmware limits and the hardware cap apply)
//   stop            all outputs off
// Calibration commands are refused while a dispense is active.
#pragma once

namespace console {

void update();
bool benchPumpActive();

}  // namespace console
