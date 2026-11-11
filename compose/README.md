# compose/

The kernel's compose layout, TASK-040 Q2. The five projects of the pooled stack
live here and at the root:

- the state project is the root `docker-compose.yml` plus
  `docker-compose.prod.yml`;
- the app colours are the root `docker-compose.app.yml` (gremion-ui,
  gremion-public, control-panel, kernel-api and the profile-gated module
  services), plus the dev-only `docker-compose.app.dev.yml`;
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
- No `compose/services/` directory exists. The extracted module services
  (`calendar-service`, `content-service`, `newsletter-service`, each behind
  its module's compose profile) are services of the root
  `docker-compose.app.yml`: `traefik.enable=false`, the `<svc>-${COLOUR}`
  alias on the colour's own `app` network and on `${STACK}_state` (no edge
  network, no published port), a memory and CPU limit, and external volumes
  only. `scripts/check-pooled-stack.mjs` must classify every
  service in its placement table before it ships.
