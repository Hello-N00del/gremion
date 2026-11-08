## Post-condition

```bash
slug="<each customer's slug, in turn>"
gremion-tenant reconcile "$slug" | grep '^{' | jq -r '.checks[] | select(.ok | not) | .name'     # no output: every check ok
```
