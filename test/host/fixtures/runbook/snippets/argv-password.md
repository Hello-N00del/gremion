
## Appended step (fixture: the admin password on the docker exec command line)

```bash
docker exec "$kc" /opt/keycloak/bin/kcadm.sh config credentials --server http://127.0.0.1:8080/auth \
  --realm master --user "$KEYCLOAK_ADMIN" --password "$KEYCLOAK_ADMIN_PASSWORD"
```
