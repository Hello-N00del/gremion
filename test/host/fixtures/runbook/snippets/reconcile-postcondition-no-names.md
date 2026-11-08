## Post-condition

```bash
slug="<each customer's slug, in turn>"
report="$(gremion-tenant reconcile "$slug")" && printf '%s\n' "$report" | grep '^{' | jq -es 'length > 0 and all(.[]; .ok == true and (.checks | type == "array" and length > 0) and all(.checks[]; .ok == true))'     # true
```
