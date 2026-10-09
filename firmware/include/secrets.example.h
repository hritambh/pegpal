// Copy to secrets.h (gitignored) and fill in. NEVER commit secrets.h.
//
// MACHINE_ID, HMAC_KEY_ID and HMAC_SECRET come from the backend admin API:
//   POST /api/admin/machines/:id/credentials
// The secret is shown once. Revoke with POST /api/admin/credentials/:keyId/revoke
// and reflash with a new credential.
#pragma once

#define WIFI_SSID "your-ssid"
#define WIFI_PASSWORD "your-wifi-password"

#define MQTT_HOST "broker.example.com"  // must match the broker certificate's CN/SAN
#define MQTT_PORT 8883
#define MQTT_USERNAME "MACHINE_001"
#define MQTT_PASSWORD "change-me"

#define MACHINE_ID "MACHINE_001"

// Application-layer HMAC-SHA256 credential.
#define HMAC_KEY_ID "k_replace_me"
// Paste the `secret` string exactly as the API returned it (a 43-char base64url
// string). The HMAC key is the UTF-8 bytes of that string. Do NOT base64- or
// hex-decode it (see docs/hardware-protocol.md, Envelope).
#define HMAC_SECRET "replace-with-issued-secret"

// PEM of the CA that signed the broker's certificate (pinned; no public CA bundle).
static const char MQTT_CA_CERT_PEM[] = R"PEM(-----BEGIN CERTIFICATE-----
REPLACE_WITH_YOUR_BROKER_CA_CERTIFICATE
-----END CERTIFICATE-----
)PEM";
