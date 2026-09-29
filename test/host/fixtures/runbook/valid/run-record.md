# Run record (fixture)

| Column | Meaning |
|---|---|
| `procedure_kind` | install, upgrade, backup or restore |
| `scope` | platform or customer |
| `customer_id` | empty for platform |
| `performed_by_kind` | person, operator or external |
| `performed_by` | a pseudonymous id |
| `non_vendor` | false when performed_by_kind is operator |
| `started_at` | start |
| `finished_at` | finish |
| `wall_clock_minutes` | derived |
| `post_condition_met` | true or false |
| `published_ref` | path@version+commit |
