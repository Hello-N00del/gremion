# compose/

The kernel's compose layout, TASK-040 Q2. The five projects of the pooled stack
live here and at the root:

- the state project is the root `docker-compose.yml` plus
  `docker-compose.prod.yml`;
- the app colours are the root `docker-compose.app.yml`, plus the dev-only
  `docker-compose.app.dev.yml`;
- the non-council projects are `compose/observability/` (`${STACK}-ops`,
  TASK-039) and `infra/host/mail/`.

`docs/ops/pooled-stack-layout.md` records the placement and the limits.

This directory holds:

- `compose/observability/`: the operator-only observability stack (TASK-039),
  project `${STACK}-ops`. It is non-council and runs in its own project and
  network, with no route to a council data store (TRD-045, TRD-203); its host
  half (render, collector, image pins) stays in `infra/host/ops/`. See its
  README.
- `compose/control-panel/`: the standalone control panel for a host without
  the pooled stack (TASK-043 G11).
- `compose/services/<id>.yml` (later units): one app-tier fragment per
  extracted module service (TASK-084). Each fragment follows the app file's
  conventions: `traefik.enable=false`, the `<svc>-${COLOUR}` alias on
  `${STACK}_edge` and `${STACK}_state`, a memory and CPU limit, and external
  volumes only. `scripts/check-pooled-stack.mjs` must classify each fragment
  in its placement table before the fragment ships.
