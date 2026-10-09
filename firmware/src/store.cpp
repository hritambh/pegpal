#include "store.h"

#include <Preferences.h>

#include "config.h"
#include "secrets.h"

namespace store {
namespace {

Preferences s_prefs;
uint32_t s_lastSeq = 0;
uint32_t s_deviceSeq = 0;
uint32_t s_deviceSeqReserved = 0;
String s_bootInFlight;

}  // namespace

void begin() {
  s_prefs.begin("pegpal", false);

  String storedKey = s_prefs.getString("keyId", "");
  if (storedKey != HMAC_KEY_ID) {
    // New credential: deviceSeq restarts (protocol.ts: "resets only on
    // credential change"). The command seq does not, since the backend keeps it per machine.
    s_prefs.putString("keyId", HMAC_KEY_ID);
    s_prefs.putUInt("devSeqRes", 0);
  }

  s_lastSeq = s_prefs.getUInt("lastSeq", 0);
  // Start beyond everything that may have been used before the last reboot.
  s_deviceSeq = s_prefs.getUInt("devSeqRes", 0);
  s_deviceSeqReserved = s_deviceSeq;

  s_bootInFlight = s_prefs.getString("inFlight", "");
}

uint32_t lastSeq() { return s_lastSeq; }

void setLastSeq(uint32_t seq) {
  if (seq <= s_lastSeq) return;
  s_lastSeq = seq;
  s_prefs.putUInt("lastSeq", seq);
}

uint32_t nextDeviceSeq() {
  s_deviceSeq++;
  if (s_deviceSeq >= s_deviceSeqReserved) {
    s_deviceSeqReserved = s_deviceSeq + DEVICE_SEQ_RESERVE_BLOCK;
    s_prefs.putUInt("devSeqRes", s_deviceSeqReserved);
  }
  return s_deviceSeq;
}

void setInFlight(const char* commandId) { s_prefs.putString("inFlight", commandId); }

void clearInFlight() { s_prefs.remove("inFlight"); }

String bootInFlight() { return s_bootInFlight; }

scale::Calibration loadScaleCalibration() {
  scale::Calibration c;
  c.countsPerG = s_prefs.getFloat("sclCpg", SCALE_DEFAULT_COUNTS_PER_G);
  c.emptyRaw = s_prefs.getInt("sclEmpty", 0);
  c.emptyValid = s_prefs.getBool("sclEmptyOk", false);
  return c;
}

void saveScaleCalibration(const scale::Calibration& c) {
  s_prefs.putFloat("sclCpg", c.countsPerG);
  s_prefs.putInt("sclEmpty", c.emptyRaw);
  s_prefs.putBool("sclEmptyOk", c.emptyValid);
}

}  // namespace store
