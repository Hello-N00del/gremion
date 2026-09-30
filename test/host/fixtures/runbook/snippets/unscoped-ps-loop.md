
## Post-condition

```bash
for c in $(docker ps --format '{{.Names}}'); do
  docker exec "$c" printenv SMTP_HOST
done
```
