
```bash
/opt/gremion/bin/gremion-restore-into --stack gremion --snapshot latest \
  --proof-file "${file}:${sha}" --proof-row db=gremion sql="$sql" want="$want"
```
