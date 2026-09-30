# scripts/release — supply chain (TASK-046)

Key-based cosign signing, SOPS/age for committed secrets, CycloneDX 1.6 SBOM
attestations, and runner credential scope (TRD-441/442/443/445). Nothing here
uses a public transparency log: images are signed with the operator's key and
verified against the host's pinned public key (D R20-D18).

## What runs where

| Piece | Where | What it asserts |
|---|---|---|
| `infra/host/bin/gremion-deploy` (step 2, `verify_first_party_signatures`) | host | every image compose resolves is either first-party and verifies with `$ROOT/etc/cosign.pub`, or on the host's `etc/third-party-images`; cosign's JSON must bind that digest to that repository; missing cosign, missing key, empty set, unreachable registry = refusal before step 3's pull |
| `infra/host/bootstrap.sh --cosign-pubkey PATH trust` | host (root) | installs cosign v2.6.5 (sha256-pinned) and the public key as `$ROOT/etc/cosign.pub` 0644; refuses a private key |
| `sign-release.sh --key K <repo>@sha256:…` | operator workstation | clean tree + green `scripts/verify/check-record.mjs --commit HEAD` (absent = refuse); signs + attests by digest only, no tlog; post-verifies both in the registry |
| `check-sops.mjs` | `verify` | no plaintext secret-class file, no key material, recipients from `.sops.yaml` only |
| `../verify/sbom/check-sbom.mjs` | `verify` | lockfile source SBOM always; with `--pins/--key`, every image's CycloneDX 1.6 attestation verifies with the pinned key; fails below a `check-cve-floors.mjs` floor or on an unaccepted CRITICAL; missing grype DB fails |
| `check-runner-scope.mjs --live` | operator, dated | GitHub API view of both repos: Actions on ⇒ no key-class secret, no self-hosted runner |
| `check-dependabot-dockerfiles.mjs`, `check-lockfile-committed.mjs`, `check-pins.mjs` | `verify` | Release-1 B35 adapts |
| `lint-release.sh` | lint | runs every suite here and in `scripts/verify/sbom/`, asserts collected == declared tests, shellchecks `*.sh` |
| `check-image-digests.mjs` (TASK-048) | `make lint-image-digests`, verify carve-lint | every `image:`, `*_IMAGE=` and `${*_IMAGE:-d}` in the discovered scan set (root-anchored `git ls-files` pathspecs; exclusions in `image-scan-exclusions.json`, reason required, stale = fail) is `<repo>[:tag]@sha256:<64 hex>`, bar first-party `${IMAGE_TAG:-dev}`/`${IMAGE_TAG:?}` on a `build:` service; no `latest` default; no object-storage image, profile, `MINIO_*`/`*_S3_*` key or S3 client in the lockfile (TRD-350/066/354). `--third-party-list` prints the host's `etc/third-party-images` |
| `emit-pins.mjs` (TASK-048, TASK-048b) | operator workstation, release | `--project state\|app` writes `docker-compose.state-pins.yml` / `docker-compose.pins.yml` from the release's one `svc=<repo>@sha256:…` record, partitioned by the derived sets; refuses anything `check-pins.mjs` refuses |
| `check-pins.mjs --project state\|app` (TASK-048b) | `verify`, release | the expected set is derived from every `build:` service in the project's template `COMPOSE_FILE` files (pins slot excluded), never listed |
| `check-image-digests.mjs --render` (TASK-048b) | `make lint-image-digests` | the rendered release: state, app-blue, app-green, ops and mail rendered from their templates with the emitted pins (`test/host/fixtures/release/valid`); every image `@sha256:`, no kept `build`, every derived service rendered, STATE PURITY on the state render (`lib/render.mjs`) |
| `release-signing.rehearsal.test.mjs` (TASK-048) | lint (`lint-release.sh`) | the `docs/ops/release-signing.md` sequence on throwaway material with a stub check record: signs, verifies with the rehearsal key, no tlog, another key fails |

Tool pins live in `lib/tools.mjs` (registry, syft and grype by digest; cosign by
release-asset sha256). `bootstrap.sh` and `sign-release.sh` repeat the cosign
and syft pins; tests assert they are equal.

## Operator activation checklist

These are operator steps. Until each is done, the named check FAILS; that
failure is expected, and nothing here signs with a real key before it.

1. **Signing key.** On the offline workstation: `cosign generate-key-pair`. Put
   `cosign.key` and its password in the operator vault and the recovery kit
   only, never in a checkout (`sign-release.sh` refuses a key path inside the
   repository). Keep `cosign.pub`.
2. **Host trust anchor.** On every host:
   `sudo infra/host/bootstrap.sh --cosign-pubkey /path/to/cosign.pub trust`.
   Until then `gremion-deploy` refuses at step 2 (`trust anchor absent`).
3. **Host third-party list.** Step 2 verifies every image that
   `docker compose config --images` resolves for the state project and both
   colours, with every profile turned on (so the `migrate` service is
   included), plus every canonical pin in `docker-compose.pins.yml` and
   `docker-compose.state-pins.yml`. An image
   outside `<registry>/hello-n00del/` is refused unless its repository is
   listed, one per line with no tag or digest, in
   `$ROOT/etc/third-party-images`. That file lives on the host and is never
   read from the release tree. List exactly the third-party repositories the
   stack runs (for example the database image). A pin's tag is ignored (the
   digest is what is pulled), and Docker Hub names are compared in canonical
   form, so the pin `redis:7-alpine@sha256:…` matches either
   `docker.io/library/redis` or `redis` in the list.
4. **age recipient.** DONE (bcfcf054, 2026-09-26): the operator's `age1…`
   public recipient replaced the
   `<OPERATOR_AGE_PUBLIC_KEY_REPLACE_VIA_BOOTSTRAP_SOPS_SH>` sentinel in
   `/.sops.yaml` (the private half is in the vault and the recovery kit), and
   `node scripts/release/check-sops.mjs` reports zero problems. A sentinel
   back in `/.sops.yaml` fails with `sentinel-recipient`
   (`check-sops.test.mjs` proves the refusal on a fixture).
5. **Grype DB.** On the workstation that runs `verify`, allow `grype db update`
   to reach the Anchore DB host, or `check-sbom` fails with `grype-db`.
6. **Runner scope evidence.** With a token that can read Actions settings on
   both repos:
   `node scripts/release/check-runner-scope.mjs --live --out <vault>/evidence/runner-scope-<date>.json`.
   Evidence older than 7 days fails. If Actions is off, the run records
   "no runner in use" and lists dormant key-class secrets (for example
   `DEPLOY_SSH_KEY`). Removing them is the operator's call (Q6). Re-enabling
   Actions with any of them present fails the check.
7. **First signed release.** `COSIGN_PASSWORD=… scripts/release/sign-release.sh --key <vault path> <each image>@sha256:…`
   once the check record for HEAD is green (TASK-045/048).

## Tests

`node --test 'scripts/release/*.test.mjs' 'scripts/verify/sbom/*.test.mjs'` (or
`scripts/release/lint-release.sh`). Pass files or quoted globs, never the
directories: on Node 26 a directory argument collects no test and fails.
The tests need docker, the pinned cosign on PATH, `sops`, `age-keygen` and
`openssl`. Anything missing is a failure, not a skip. They start digest-pinned
containers named `t046-<8 hex>-<role>` on `127.0.0.1:<free port>` and remove
them by name afterwards. Keys are ephemeral, created in the gitignored
`.t046-tmp/` and deleted when the run ends.
