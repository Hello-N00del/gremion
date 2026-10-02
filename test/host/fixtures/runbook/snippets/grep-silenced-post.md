
## Post-condition

```bash
docker exec "$c" env 2>/dev/null | grep -E '^SMTP_HOST=' | sed "s/^/${c} /"
```
