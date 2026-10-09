// Wi-Fi + MQTT 3.1.1 over TLS (pinned CA), SNTP, outbound queue, inbound queue.
//
// Topics: pegpal/v1/{machineId}/cmd (sub, QoS 1), /evt (pub), /online (retained,
// "1" on connect, LWT "0").
#pragma once

#include <Arduino.h>

namespace net {

void begin();

// Wi-Fi/MQTT upkeep and outbox draining. While `pumpRunning` is true the link
// will not start a (blocking) reconnect and drains at most one event per call.
void update(bool pumpRunning);

bool connected();
uint32_t offlineMs();   // 0 while connected
bool consumeJustConnected();

// reliable = QoS 1 and kept until PUBACK (survives disconnects);
// otherwise QoS 0 and dropped while offline.
void enqueue(const String& envelope, bool reliable);

// Next inbound cmd message, if any.
bool popInbound(String& out);

}  // namespace net
