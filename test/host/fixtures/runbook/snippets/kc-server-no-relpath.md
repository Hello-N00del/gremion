
## Appended step (fixture: kcadm pointed at the server root, without Keycloak's relative path)

```bash
KC_CLI_PASSWORD="$KEYCLOAK_ADMIN_PASSWORD" docker exec -e KC_CLI_PASSWORD "$kc" /opt/keycloak/bin/kcadm.sh config credentials --server http://127.0.0.1:8080 \
  --realm master --user "$KEYCLOAK_ADMIN"
```
