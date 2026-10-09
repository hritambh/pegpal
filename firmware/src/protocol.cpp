#include "protocol.h"

#include <esp_random.h>
#include <esp_timer.h>
#include <mbedtls/md.h>
#include <sys/time.h>

#include "config.h"
#include "secrets.h"
#include "store.h"

namespace protocol {
namespace {

constexpr size_t kSigHexLen = 64;

bool hmacHex(const char* data, size_t len, char out[kSigHexLen + 1]) {
  uint8_t mac[32];
  const mbedtls_md_info_t* info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  if (info == nullptr) return false;
  const char* key = HMAC_SECRET;
  if (mbedtls_md_hmac(info, reinterpret_cast<const unsigned char*>(key), strlen(key),
                      reinterpret_cast<const unsigned char*>(data), len, mac) != 0) {
    return false;
  }
  static const char hex[] = "0123456789abcdef";
  for (int i = 0; i < 32; i++) {
    out[i * 2] = hex[mac[i] >> 4];
    out[i * 2 + 1] = hex[mac[i] & 0x0f];
  }
  out[kSigHexLen] = 0;
  return true;
}

}  // namespace

bool constantTimeEquals(const char* a, const char* b, size_t n) {
  volatile uint8_t diff = 0;
  for (size_t i = 0; i < n; i++) diff |= (uint8_t)(a[i] ^ b[i]);
  return diff == 0;
}

OpenResult openEnvelope(const char* data, size_t len, String& payloadOut) {
  JsonDocument env;
  if (deserializeJson(env, data, len) != DeserializationError::Ok) return OpenResult::MALFORMED;
  if (!env["keyId"].is<const char*>() || !env["sig"].is<const char*>() ||
      !env["payload"].is<const char*>()) {
    return OpenResult::MALFORMED;
  }
  const char* keyId = env["keyId"];
  const char* sig = env["sig"];
  // The payload may legally contain NUL-free UTF-8 only (it is JSON text).
  JsonString payload = env["payload"].as<JsonString>();

  // The firmware knows exactly one key. Revocation happens on the backend, which
  // stops accepting/signing with a revoked key; the device needs a reflash.
  if (strcmp(keyId, HMAC_KEY_ID) != 0) return OpenResult::UNKNOWN_KEY;
  if (strlen(sig) != kSigHexLen) return OpenResult::BAD_SIG;

  char expected[kSigHexLen + 1];
  if (!hmacHex(payload.c_str(), payload.size(), expected)) return OpenResult::BAD_SIG;
  if (!constantTimeEquals(expected, sig, kSigHexLen)) return OpenResult::BAD_SIG;

  payloadOut = String(payload.c_str(), payload.size());
  return OpenResult::OK;
}

String sealEnvelope(const String& payload) {
  char sig[kSigHexLen + 1];
  if (!hmacHex(payload.c_str(), payload.length(), sig)) sig[0] = 0;
  JsonDocument env;
  env["keyId"] = HMAC_KEY_ID;
  env["sig"] = sig;
  env["payload"] = payload;  // serialized as a JSON string (escaped)
  String out;
  serializeJson(env, out);
  return out;
}

String finalizeEvent(JsonDocument& doc) {
  doc["v"] = PROTOCOL_VERSION;
  doc["eventId"] = newUuid();
  doc["machineId"] = MACHINE_ID;
  doc["deviceSeq"] = store::nextDeviceSeq();
  doc["uptimeMs"] = (uint64_t)(esp_timer_get_time() / 1000);
  doc["simulated"] = false;
  String payload;
  serializeJson(doc, payload);
  return sealEnvelope(payload);
}

String newUuid() {
  uint8_t b[16];
  esp_fill_random(b, sizeof(b));
  b[6] = (b[6] & 0x0f) | 0x40;  // version 4
  b[8] = (b[8] & 0x3f) | 0x80;  // variant 10
  char s[37];
  snprintf(s, sizeof(s),
           "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
           b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], b[8], b[9], b[10], b[11], b[12],
           b[13], b[14], b[15]);
  return String(s);
}

bool epochMs(uint64_t* out) {
  struct timeval tv;
  gettimeofday(&tv, nullptr);
  if (tv.tv_sec < TIME_VALID_AFTER_EPOCH_S) return false;
  *out = (uint64_t)tv.tv_sec * 1000ULL + (uint64_t)(tv.tv_usec / 1000);
  return true;
}

}  // namespace protocol
