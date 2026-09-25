#!/usr/bin/env bash
# Run the Flutter app on a physical Android device over LAN.
# Set HOST_IP to your machine's local IP (check with `ipconfig`).
set -e

HOST_IP="${HOST_IP:-192.168.0.13}"

flutter run \
  --dart-define=GATEWAY_URL=http://"$HOST_IP":3001 \
  --dart-define=HOMESERVER_URL=http://"$HOST_IP":8009 \
  --dart-define=KEYCLOAK_ENDPOINT_BASE=http://"$HOST_IP":8082/auth/realms/sturaos \
  "$@"
