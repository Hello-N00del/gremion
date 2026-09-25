#!/usr/bin/env bash
# Run the Flutter app on a local Android emulator.
# The emulator reaches the host machine via 10.0.2.2.
set -e

flutter run \
  --dart-define=GATEWAY_URL=http://10.0.2.2:3001 \
  --dart-define=HOMESERVER_URL=http://10.0.2.2:8009 \
  --dart-define=KEYCLOAK_ENDPOINT_BASE=http://10.0.2.2:8082/auth/realms/sturaos \
  "$@"
