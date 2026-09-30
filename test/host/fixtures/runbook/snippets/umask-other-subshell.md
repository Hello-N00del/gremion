
## Appended step (fixture: umask 077 in a subshell that closed before the redirect)

```bash
( umask 077; true ); docker compose --env-file /opt/gremion/etc/env/state.env exec -T "$svc" pg_dump -U postgres -Fc "$db" > "$dump"
```
