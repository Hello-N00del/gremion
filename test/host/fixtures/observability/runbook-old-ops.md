
Seeded line (TASK-039 TDD 17): an operator following this would tunnel to a
port that no longer exists.

```bash
ssh -N -L 9093:127.0.0.1:9093 gremion@host.example.org
```
