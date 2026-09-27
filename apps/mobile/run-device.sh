#!/usr/bin/env bash
# Run the Flutter app on a physical Android device over LAN.
# Set HOST_IP to your machine's local IP (check with `ipconfig`) before running.
set -e

if [ -z "${HOST_IP:-}" ]; then
  echo "HOST_IP is not set. Example: HOST_IP=192.168.1.42 ./run-device.sh" >&2
  exit 1
fi

flutter run \
  --dart-define=GATEWAY_URL=http://"$HOST_IP":3001 \
  --dart-define=HOMESERVER_URL=http://"$HOST_IP":8009 \
  --dart-define=KEYCLOAK_ENDPOINT_BASE=http://"$HOST_IP":8082/auth/realms/gremion \
  "$@"
