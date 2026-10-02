
## Appended step (fixture: a dump written under the caller's umask, then chmod'ed)

```bash
docker compose --env-file /opt/gremion/etc/env/state.env exec -T "$svc" \
  pg_dump -U postgres -Fc "$db" > "$dump"
chmod 600 "$dump"
```
