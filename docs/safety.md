# PegPal safety design

PegPal moves liquids, some of them alcoholic, with motors, next to electronics
and members of the public. Software, including the firmware in `firmware/`, is a
**secondary** safety layer. The primary layer is the electrical design below.

The firmware is **untested on hardware**. Nothing in this repository has been
certified or assessed by anyone.

Terms: **Required** means do not operate the machine without it. **Recommended**
means strongly advised; deviate only with a documented reason. Component types
are given as examples. This document does not mandate specific part numbers;
choose parts rated for your voltages, currents and environment.

## 1. Emergency stop

**Required**

- A latching, red-on-yellow **mushroom-head emergency-stop switch** with
  **normally-closed (NC)** contacts, reachable by the operator.
- The NC contact **breaks the motor supply in hardware**. Wire it in series with
  the coil of a contactor or relay whose contacts carry the pump supply, or
  directly in the supply if the switch is rated for the full current.
  Stopping must happen by **de-energizing**: pressing the switch, a broken wire,
  or loss of coil power must all leave the motors unpowered. No software, MCU
  pin or firmware state may be needed to stop the motors.
- A **second, separate contact** on the same switch goes to the ESP32
  (`ESTOP_PIN`) **for status only**, so the firmware can latch, report `ESTOP`
  and refuse commands. Wire it fail-safe: NC contact to GND with a pull-up, so
  "pressed" and "wire broken" both read as active.
- After release, motor power must not return by itself. Restart requires a
  deliberate local action. The firmware requires the local reset button, and
  the motor-enable relay stays off until a new dispense starts. If your
  contactor circuit would re-energize on release, add a hardware
  start/reset (self-holding) circuit.
- No remote message can clear the e-stop. This is enforced in firmware and
  must not be "improved" away.

**Recommended**

- A self-holding contactor circuit (start button + e-stop in the hold path),
  so power loss also requires a manual restart.
- A safety relay module if the machine falls under machinery-safety rules in
  your jurisdiction (see section 8).

## 2. Power supply and fusing

**Required**

- A **separate motor power supply** from the logic supply (or at least a
  separately fused and filtered branch). Pump inrush and back-EMF must not
  brown out the ESP32.
- A **main fuse** (or breaker) on the motor supply, sized to the wiring and the
  PSU.
- A **fuse per pump channel** (fuse, PTC or electronic fuse) sized just above
  that pump's running current with inrush margin. A stalled pump or shorted
  cable must not overheat the wiring.
- **Common ground** between the motor supply, the drivers and the ESP32
  (star-point recommended), so the gate signals have a defined reference.
- Mains-side wiring (PSU input, IEC inlet, earth bonding of metal enclosures)
  done to local electrical code by a qualified person.

**Recommended**

- A PSU with over-current, over-voltage and short-circuit protection.
- Brown-out detection kept enabled on the ESP32 (it is by default).

## 3. Pump drivers

**Required**

- Pumps are switched by **drivers**, never directly from a GPIO: logic-level
  **N-channel MOSFET low-side switches** for one-direction peristaltic pumps,
  or an H-bridge if reverse is ever needed (the firmware never reverses).
- A **flyback diode** across each brushed DC motor (or a driver with built-in
  clamping), rated for the motor current.
- A **gate pull-down resistor** on every MOSFET gate (or the equivalent default-off
  input on an H-bridge/driver), so **every pump is OFF while the ESP32 is in reset,
  in the bootloader, being flashed, or unpowered**. GPIOs float during reset
  and boot. The firmware drives them LOW as its first action, but that happens
  hundreds of milliseconds after power-up.
- **Do not use ESP32 strapping pins for pump or relay outputs**: GPIO0, GPIO2,
  GPIO5, GPIO12 and GPIO15 (on the classic ESP32) have boot-time pull-ups or
  pull-downs and can glitch or change the boot mode. Also avoid GPIO6–11 (flash),
  GPIO1/3 (UART), and pins that output signals during boot (e.g. GPIO14).
  Other ESP32 variants have different strapping pins; check the datasheet.
- The motor-enable relay coil also needs a default-off driver (pull-down on the
  transistor base/gate) and a flyback diode across the coil if it is a bare relay.

**Recommended**

- A small gate series resistor to limit ringing.
- A current-sense or fuse-blown indication per channel, for future `PUMP_FAULT`
  detection.

## 4. Watchdog and fail-stopped behaviour (firmware, secondary layer)

Implemented in `firmware/` (see `firmware/README.md`). Not a substitute for
sections 1–3.

- Every pump output is driven OFF first in `setup()`, before networking.
- Task watchdog (`WDT_TIMEOUT_S`): a hang resets the chip; after reset nothing resumes.
- Every pump run is capped by a hardware timer whose interrupt switches the
  outputs off independently of the main loop (`FW_MAX_PUMP_RUNTIME_MS`).
- Only one pump runs at a time. Link loss stops the pump after `LINK_LOSS_STOP_MS`.
- Scale faults (no data, glass removed, implausible mass change, no flow)
  stop the pump.
- All limits are compile-time constants; no message can change them or name a GPIO.

**Recommended:** an external hardware watchdog or a hardware max-on-time circuit
(e.g. a monostable on the motor-enable relay) for an extra layer independent of the MCU.

## 5. Enclosure, liquids and electronics

**Required**

- Electronics (ESP32, drivers, PSU) are **physically separated from liquid
  paths**, mounted above them, with drip shields so a leak or burst tube cannot
  drip onto live parts.
- An enclosure rating appropriate for the location. For a bar or kiosk where
  spills and cleaning are expected, aim for at least splash protection (e.g.
  IP54 for the electronics compartment). Assess the actual environment.
- A drip tray under the dispensing area, and a defined drain/overflow path away
  from electronics.
- No exposed mains or motor-supply conductors reachable by the public.
- Cable glands / strain relief on every cable entering the enclosure.

**Recommended**

- Leak detection in the bottom of the electronics compartment, wired to cut
  motor power or at least report a fault.
- Ventilation or thermal design for the PSU and drivers.

## 6. Food contact and hygiene

**Required**

- All tubing, fittings, reservoirs and nozzles in contact with drinks are made
  of **food-contact-grade materials** suitable for the liquids used (alcohol,
  acids in juices, sugar). Use pump tubing certified for food contact in your
  jurisdiction.
- A documented **cleaning and sanitizing procedure** and schedule, and a
  tubing replacement interval (peristaltic tubing wears and sheds).
- Lubricants on any part near the liquid path are food-grade.

**Recommended**

- Separate tubing per liquid; no cross-connection between channels.
- Material compatibility checked for high-proof spirits.

## 7. Load cell and measurement

- The scale is used for supervision (glass present, flow detected, overflow
  prevention) and for inferring dispensed volume. It is not a legal-for-trade
  measuring instrument. If dispensed volume is a legally regulated quantity
  where you operate (e.g. pour sizes for spirits), you may need certified
  measuring equipment.

## 8. Compliance (must be reviewed per jurisdiction)

**Software does not satisfy any of these.** Each must be reviewed by the
operator with qualified legal/compliance advice for every jurisdiction where a
machine is installed:

- **Alcohol licensing:** whether unattended or semi-attended dispensing of
  alcohol is permitted at all, licence type, permitted hours, staff supervision
  requirements, pour-size and labelling rules.
- **Age verification:** how legal drinking age is verified before dispensing
  alcohol (often requires in-person staff checks; QR ordering alone does not
  verify age), and refusal of service to intoxicated persons.
- **Payment compliance:** PCI DSS scope of the payment flow, consumer
  protection, refunds for failed or partial dispenses, receipts and tax.
- **Food safety and food contact:** food-business registration, hygiene rules,
  food-contact material regulations, cleaning records, allergen information.
- **Electrical and machine certification:** e.g. electrical safety, EMC and
  radio approval (the ESP32 module's certification does not cover the whole
  product), machinery-safety requirements, and the marks required to place the
  product on the market (CE/UKCA/UL/FCC or the local equivalent).
- **Accessibility and consumer law** for a public-facing kiosk, where applicable.

Until these are reviewed, run the system in test mode only, with water, and
with a person supervising.
