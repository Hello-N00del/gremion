# verticals/stura

The Studierendenrat vertical as data (the format is documented in `verticals/README.md`). It is
public data: a blueprint, roles and wording carry no host, address, credential or person. The
tenant-create image copies this directory to `/repo/verticals/stura` (or `GREMION_VERTICALS_DIR`
points at a directory holding it).

- `blueprint.json` is derived from `STURA_BLUEPRINT` (11 units, the offices);
  `gremion-ui/src/lib/server/seed/vertical-parity.test.ts` keeps the two equal.
- `wording.de.json` is empty on purpose: the code defaults are this vertical's terms.
- `roles.json` holds the member and helper roles. The helper default (five capabilities granted,
  four withheld) is the vendor default of PRD-IDN-003; `brd.*` ids are inert data while the board
  module is off.
