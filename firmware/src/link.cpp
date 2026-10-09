#include "link.h"

#include <MQTT.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <esp_task_wdt.h>

#include "config.h"
#include "secrets.h"

namespace net {
namespace {

WiFiClientSecure s_net;
MQTTClient s_mqtt(MQTT_BUFFER_SIZE, MQTT_BUFFER_SIZE);

String s_topicCmd, s_topicEvt, s_topicOnline;

bool s_wifiStarted = false;
bool s_sntpStarted = false;
uint32_t s_lastWifiAttempt = 0;
uint32_t s_lastMqttAttempt = 0;
bool s_wasConnected = false;
bool s_justConnected = false;
uint32_t s_offlineSince = 0;  // millis when the link went down; 0 = never connected yet

// Outbox (reliable events)
String s_outbox[OUTBOX_SIZE];
int s_outHead = 0, s_outCount = 0;

// Inbox (filled from the MQTT callback; processed in loop, never in the callback)
String s_inbox[INBOX_SIZE];
int s_inHead = 0, s_inCount = 0;

void onMessage(MQTTClient* client, char topic[], char bytes[], int length) {
  if (strcmp(topic, s_topicCmd.c_str()) != 0) return;
  if (s_inCount >= INBOX_SIZE) {
    Serial.println("[link] inbox full; command dropped (backend will retry)");
    return;
  }
  int idx = (s_inHead + s_inCount) % INBOX_SIZE;
  s_inbox[idx] = String(bytes, length);
  s_inCount++;
}

void tryMqttConnect() {
  s_lastMqttAttempt = millis();
  esp_task_wdt_reset();  // the TLS handshake blocks (bounded by TLS_HANDSHAKE_TIMEOUT_S)
  s_mqtt.setWill(s_topicOnline.c_str(), "0", true, 1);
  bool ok = s_mqtt.connect(MACHINE_ID, MQTT_USERNAME, MQTT_PASSWORD);
  esp_task_wdt_reset();
  if (!ok) {
    Serial.printf("[link] mqtt connect failed: err=%d rc=%d\n", (int)s_mqtt.lastError(),
                  (int)s_mqtt.returnCode());
    return;
  }
  s_mqtt.subscribe(s_topicCmd.c_str(), 1);
  s_mqtt.publish(s_topicOnline.c_str(), "1", true, 1);
  Serial.println("[link] mqtt connected");
}

void drainOutbox(int maxCount) {
  while (maxCount-- > 0 && s_outCount > 0 && s_mqtt.connected()) {
    const String& msg = s_outbox[s_outHead];
    // QoS 1 publish waits for PUBACK (bounded by MQTT_TIMEOUT_MS).
    if (!s_mqtt.publish(s_topicEvt.c_str(), msg.c_str(), (int)msg.length(), false, 1)) {
      return;  // keep it; retry later (same eventId, the backend dedups)
    }
    s_outbox[s_outHead] = String();
    s_outHead = (s_outHead + 1) % OUTBOX_SIZE;
    s_outCount--;
  }
}

}  // namespace

void begin() {
  String base = String("pegpal/v1/") + MACHINE_ID;
  s_topicCmd = base + "/cmd";
  s_topicEvt = base + "/evt";
  s_topicOnline = base + "/online";

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.setAutoReconnect(true);

  s_net.setCACert(MQTT_CA_CERT_PEM);
  s_net.setHandshakeTimeout(TLS_HANDSHAKE_TIMEOUT_S);

  s_mqtt.begin(MQTT_HOST, MQTT_PORT, s_net);
  // keepalive, clean session (stale commands must not be queued for us), ack timeout
  s_mqtt.setOptions(MQTT_KEEPALIVE_S, true, MQTT_TIMEOUT_MS);
  s_mqtt.onMessageAdvanced(onMessage);
  s_offlineSince = millis();
}

void update(bool pumpRunning) {
  uint32_t now = millis();

  if (WiFi.status() != WL_CONNECTED) {
    if (!s_wifiStarted || now - s_lastWifiAttempt >= WIFI_RETRY_MS) {
      s_lastWifiAttempt = now;
      if (!s_wifiStarted) {
        WiFi.begin(WIFI_SSID, WIFI_PASSWORD);  // non-blocking
        s_wifiStarted = true;
      } else if (!pumpRunning) {
        WiFi.reconnect();
      }
    }
  } else if (!s_sntpStarted) {
    configTime(0, 0, SNTP_SERVER_1, SNTP_SERVER_2);  // UTC; SNTP runs in the background
    s_sntpStarted = true;
  }

  if (WiFi.status() == WL_CONNECTED && !s_mqtt.connected() && !pumpRunning &&
      (s_lastMqttAttempt == 0 || now - s_lastMqttAttempt >= MQTT_RETRY_MS)) {
    tryMqttConnect();
  }

  s_mqtt.loop();
  bool up = connected();
  if (up && !s_wasConnected) s_justConnected = true;
  if (!up && s_wasConnected) {
    s_offlineSince = millis();
    Serial.println("[link] mqtt disconnected");
  }
  s_wasConnected = up;

  if (up) drainOutbox(pumpRunning ? 1 : 4);
}

// Wi-Fi loss counts as link loss at once; otherwise a dead TCP session would only
// be noticed after the MQTT keepalive (~1.5 x MQTT_KEEPALIVE_S).
bool connected() { return WiFi.status() == WL_CONNECTED && s_mqtt.connected(); }

uint32_t offlineMs() {
  if (connected()) return 0;
  return millis() - s_offlineSince;
}

bool consumeJustConnected() {
  bool v = s_justConnected;
  s_justConnected = false;
  return v;
}

void enqueue(const String& envelope, bool reliable) {
  if (!reliable) {
    if (s_mqtt.connected()) {
      s_mqtt.publish(s_topicEvt.c_str(), envelope.c_str(), (int)envelope.length(), false, 0);
    }
    return;
  }
  if (s_outCount >= OUTBOX_SIZE) {
    // Oldest reliable event is lost; STATUS will still show the current truth.
    Serial.println("[link] outbox full; dropping oldest event");
    s_outHead = (s_outHead + 1) % OUTBOX_SIZE;
    s_outCount--;
  }
  s_outbox[(s_outHead + s_outCount) % OUTBOX_SIZE] = envelope;
  s_outCount++;
}

bool popInbound(String& out) {
  if (s_inCount == 0) return false;
  out = s_inbox[s_inHead];
  s_inbox[s_inHead] = String();
  s_inHead = (s_inHead + 1) % INBOX_SIZE;
  s_inCount--;
  return true;
}

}  // namespace net
