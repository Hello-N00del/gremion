# @gremion/ports

The broker, tracer and contract ports of the
[Gremion](https://github.com/Hello-N00del/gremion) governance kernel: the
`BrokerPort` contract with its in-memory implementation, the canonical
NATS/JetStream broker, the tracer port, and the content-portal contract.

```ts
import { InMemoryBroker, makeEnvelope, STREAMS } from '@gremion/ports/broker'
import { NatsBroker } from '@gremion/ports/nats'
import { tracer } from '@gremion/ports/tracer'
```

## Status: 0.x, and the contract is not frozen

Published at `0.1.0` deliberately. The runtime-registry contract this package
sits behind is explicitly not frozen, so a `1.0.0` would promise a semver
stability the project has not earned. Expect breaking changes in minor versions
until that is stated otherwise.

## What ships

The tarball contains `dist/` (compiled ESM, `.d.ts` declarations and maps),
`src/*.ts` minus the specs, `README.md` and `LICENSE` — the `files` allowlist in
`package.json`. What a consumer LOADS is `dist/`; see `packages/db/README.md`
for why raw `./src/*.ts` is not publishable as an entry point, and why `src/` is
in the tarball anyway (declaration-map resolution, and `pnpm deploy` packing the
workspace dependency into the runtime images). The `exports` map points at
`src/` for the workspace; `publishConfig.exports` overrides it to `dist/` at
pack time.

## Testing

`pnpm --filter @gremion/ports test` runs the unit specs and — when
`NATS_TEST_URL` is set — the JetStream integration proofs against a real
server. `.github/workflows/ports.yml` runs both, and asserts a post-condition
on the run (no file skipped, no test skipped, a minimum number of integration
proofs actually executed) rather than trusting the exit code: the integration
block is self-skipping by design, so a broken NATS step would otherwise turn
the job green while proving nothing.

## Licence

AGPL-3.0-only. The full text is in `LICENSE`, beside this file.
