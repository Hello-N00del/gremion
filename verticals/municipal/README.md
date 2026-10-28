# verticals/municipal

The municipal-council (Gemeinderat) vertical as data (the format is documented in
`verticals/README.md`). Public data: no host, address, credential or person.

- `blueprint.json`: Gemeinderat, Stadtverwaltung and two Ortschaftsräte as four top-level bodies
  (the kind catalogue bounds them), three Ausschüsse (one advisory), and three Fraktionen on the
  Gemeinderat. The Fraktionen carry no members: who sits in one is people data. `demoSeeder`
  selects the municipal demo set of the opt-in demo path.
- The registry serves it as `MUNICIPAL_BLUEPRINT@1` (no users, no memberships). The fictional
  people the seed tests need, including the `dev.admin` superuser, live in
  `gremion-ui/src/lib/server/seed/municipal-fixture.ts`, which is test-only; `POST
  /api/setup/seed` seeds the data tree and no fixture people, as it does for `stura`.
- `wording.de.json` is empty on purpose; `roles.json` is the member and helper roles, as in `stura`.
