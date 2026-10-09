# MQTT broker (physical hardware only)

You only need this when running `HARDWARE_MODE=esp32` (with `ENABLE_ESP32_ADAPTER=true`). Mock mode doesn't use a broker.

## 1. Certificates (development CA)

```bash
cd infra/mosquitto/certs
openssl req -x509 -newkey rsa:4096 -days 365 -nodes -keyout ca.key -out ca.crt -subj "/CN=PegPal Dev CA"
openssl req -newkey rsa:2048 -nodes -keyout server.key -out server.csr -subj "/CN=<broker-hostname>"
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt -days 365
```

For production, use a real CA and a hostname the controllers can verify. Paste `ca.crt` into the firmware's `secrets.h` (`BROKER_CA_PEM`).

## 2. Accounts

```bash
docker run --rm -v "$PWD/infra/mosquitto:/m" eclipse-mosquitto:2.0.20 \
  sh -c 'touch /m/passwd && mosquitto_passwd -b /m/passwd pegpal-backend "<backend-password>" && mosquitto_passwd -b /m/passwd MACHINE_001 "<controller-password>"'
```

The controller's username **must** equal its machine id; the ACL relies on it.

## 3. Run

```bash
docker compose --profile hardware up -d mosquitto
```

Then set the following in `apps/api/.env`:

```
MQTT_URL=mqtts://localhost:8883
MQTT_USERNAME=pegpal-backend
MQTT_PASSWORD=<backend-password>
MQTT_CA_FILE=../../infra/mosquitto/certs/ca.crt
```

Broker credentials are the first layer of authentication. Every message is also HMAC-signed with a per-machine key that the backend can revoke. See [docs/hardware-protocol.md](../../docs/hardware-protocol.md).

`certs/*` and `passwd` are gitignored. Never commit them.
