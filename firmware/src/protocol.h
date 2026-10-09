// Wire format: signed envelopes {keyId, sig, payload}, where
//   sig = lowercase_hex(HMAC_SHA256(secret, utf8(payload)))
// verified over the exact received payload bytes with a constant-time compare.
#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>

namespace protocol {

enum class OpenResult : uint8_t { OK, MALFORMED, UNKNOWN_KEY, BAD_SIG };

// Verify an inbound envelope. On OK, payloadOut holds the exact signed payload.
OpenResult openEnvelope(const char* data, size_t len, String& payloadOut);

// Sign a payload string and wrap it in an envelope.
String sealEnvelope(const String& payload);

// Fill the event base (v, eventId, machineId, deviceSeq, uptimeMs, simulated),
// serialize and seal. `doc` must already hold `type` and the event's own fields.
String finalizeEvent(JsonDocument& doc);

// Random RFC 4122 v4 UUID from the hardware RNG.
String newUuid();

// Constant-time equality of two equal-length buffers.
bool constantTimeEquals(const char* a, const char* b, size_t n);

// Wall clock (SNTP). Returns false if the clock has not been synced.
bool epochMs(uint64_t* out);

}  // namespace protocol
