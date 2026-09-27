# edge-routers fixtures

- `reserved-labels.json` — the eight reserved platform LABELS (the apex is the
  ninth reserved name). The package takes `isReservedHost` as a parameter and
  never imports gremion-ui; `test/reserved-labels.test.ts` reads
  `gremion-ui/src/lib/server/tenant/reserved-hosts.ts` and
  `infra/host/templates/env/state.env.tmpl` as TEXT and fails if either list
  drifts from this one.
