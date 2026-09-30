# Release signing (TRD-114)

Owner: TASK-048 (procedure and rehearsal); the tools are TASK-046's
(`scripts/release/README.md`). Requirement: a first-party image is signed with a
key-based cosign signature in a **manual step, after local verify passes**; the
private key is held in the operator vault and the recovery kit, **never on a CI
runner or the pilot host**. No public transparency log is used (D R20-D18).

## Key custody

- `cosign.key` and its password live in the operator vault and the recovery kit
  only. The key file must sit **outside any checkout**, in the vault path.
  `sign-release.sh` enforces the part it can see: it resolves the key path and
  refuses one inside the release checkout's toplevel, even a gitignored one
  (the `realpath` check before signing; `sign-release.test.mjs` "a key path
  inside the repository is refused"). A key inside some *other* checkout is
  not detected; keeping it in the vault path is the operator's rule.
- The pilot host holds only the public half, installed by
  `sudo infra/host/bootstrap.sh --cosign-pubkey <path>/cosign.pub trust` as
  `$ROOT/etc/cosign.pub`. `gremion-deploy` step 2 verifies every first-party pin
  against it.

## The sequence

Run on the operator workstation, from a clean checkout of the release commit.
Each step is a precondition of the next; stop at the first failure.

1. **Verify green.** `make verify`, then
   `node scripts/verify/check-record.mjs --commit "$(git rev-parse HEAD)"` must
   exit 0. `sign-release.sh` re-checks this record itself and refuses a dirty
   tree.
2. **Build and push** each first-party image to the private registry, by the
   release tag:

   ```sh
   docker buildx build --push -t ghcr.io/hello-n00del/gremion-ui:<tag> -f gremion-ui/Dockerfile .
   ```

   (one per `build:` service of `docker-compose.app.yml`; the state-project
   images are TASK-048b's). Record each pushed digest from the registry, not
   the local store:

   ```sh
   docker buildx imagetools inspect --format '{{json .Manifest}}' \
     ghcr.io/hello-n00del/gremion-ui:<tag> | jq -r .digest
   ```

   (buildx 0.31 ignores the older `--format '{{ .Manifest.Digest }}'`.)
3. **Emit the pins layer** from one `service=<repo>@sha256:<64 hex>` line per
   app service:

   ```sh
   node scripts/release/emit-pins.mjs --app-compose docker-compose.app.yml \
     --in pins.txt --out docker-compose.pins.yml
   ```

   It refuses (exit 1, nothing written) a missing, extra, duplicate or tag ref.
4. **Check the pins layer** with the same assertions `gremion-deploy` makes:

   ```sh
   node scripts/release/check-pins.mjs docker-compose.pins.yml \
     --services gremion-ui,gremion-public,migrate,tenant-create
   ```

   Pass `--services` explicitly: `--app-compose` currently reads non-service
   keys of `docker-compose.app.yml` as services (TASK-048b).
5. **Sign** every first-party digest with the vault key:

   ```sh
   COSIGN_PASSWORD=… scripts/release/sign-release.sh --key <vault>/cosign.key \
     ghcr.io/hello-n00del/gremion-ui@sha256:<64 hex> …
   ```

   It signs and attests (CycloneDX 1.6 SBOM) by digest only, with
   `--tlog-upload=false`, and fails on any output that mentions a transparency
   log.
6. **Verify** each signature with the public key only:

   ```sh
   cosign verify --key cosign.pub --insecure-ignore-tlog=true \
     ghcr.io/hello-n00del/gremion-ui@sha256:<64 hex>
   ```

   Expected: exit 0 and "The signatures were verified against the specified
   public key". The same command with any other public key must fail. To show
   there is no tlog entry, `cosign download signature <ref>` must print
   `"Bundle":null` for every signature (`--insecure-ignore-tlog` only skips the
   check, so verify output alone cannot show it).

The host's third-party allow-list comes from the same tree:
`node scripts/release/check-image-digests.mjs --third-party-list` prints the
canonical non-first-party repositories, one per line, for
`$ROOT/etc/third-party-images` (installed at TASK-038). It refuses on a tree the
digest guard rejects.

## Rehearsal (stub record)

`scripts/release/release-signing.rehearsal.test.mjs` runs steps 2–6 against
throwaway material: the TASK-046 harness's local `registry:2` on 127.0.0.1,
throwaway key pairs, and a nested throwaway repository whose check record is a
**stub record** printing `STUB: rehearsal only`. It proves the sequence signs,
verifies with the rehearsal public key, leaves no tlog line and no Rekor
bundle, fails with another key, refuses a key inside the repository, and fails (never skips) when docker or
cosign is missing. The real verify record, the vault key and the private
registry are exercised only by the first real signing below.

## First real signing (operator, Q9)

Not done by TASK-048; recorded there as a residual. On the operator
workstation, from a clean checkout of a commit whose `make verify` is green:

```sh
docker buildx build --push -t ghcr.io/hello-n00del/gremion-legal:<tag> docker/legal
REF="ghcr.io/hello-n00del/gremion-legal@$(docker buildx imagetools inspect \
  --format '{{json .Manifest}}' ghcr.io/hello-n00del/gremion-legal:<tag> | jq -r .digest)"
COSIGN_PASSWORD=… scripts/release/sign-release.sh --key <vault>/cosign.key "$REF"
cosign verify --key cosign.pub --insecure-ignore-tlog=true "$REF"
cosign download signature "$REF" | jq -c .Bundle      # every line: null
```

Record in handover section 8: `$REF` (the digest), the `cosign verify --key
cosign.pub` output, "no tlog" (the `null` bundle lines), and that the key's
recovery-kit copy was checked.

The Keycloak pin in `docker-compose.yml` was first resolved from
`docker.io/keycloak/keycloak:26.6.1` (quay.io was unreachable where TASK-048
was first implemented). It was confirmed on quay.io on 2026-09-28 (TASK-048
review round 2):
`docker buildx imagetools inspect --format '{{json .Manifest}}' quay.io/keycloak/keycloak:26.6.1`
gives the index digest
`sha256:dea26401d06341095cc4ea9d66896200b55de5ca1daa1d2fcbe58493afa6e0ad`,
the digest `docker-compose.yml` pins. Re-run the same command whenever the
Keycloak pin changes.
