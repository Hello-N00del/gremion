#!/usr/bin/env bash
#
# sign-release.sh — the operator's manual signing step (TASK-046, TRD-441/443).
# Run by the release procedure (TASK-048) on the operator workstation, AFTER
# the images are pushed to the private registry and BEFORE the host deploys.
#
# USAGE
#   COSIGN_PASSWORD=… scripts/release/sign-release.sh --key <cosign.key> <repo>@sha256:<64 hex>...
#
# COSIGN_PASSWORD must be set (empty for a key without one): every cosign call
# below captures stderr, where cosign would prompt, so an unset password is a
# refusal, never a hang on a prompt nobody sees. cut-dist-tag.sh sets it from
# COSIGN_PASSWORD_FILE for this process alone.
#
# For every image, by digest only:
#   1. cosign sign   --key K --tlog-upload=false        (no public transparency log)
#   2. syft (digest-pinned container) → CycloneDX 1.6 SBOM of that digest
#      (all SBOMs are built before the first signature is pushed)
#   3. cosign attest --key K --type cyclonedx --tlog-upload=false
#   4. post-conditions: `cosign verify` and `cosign verify-attestation` with the
#      public half derived from K both pass, and the output carries no tlog line.
#
# REFUSALS (nothing is signed):
#   - the working tree is not clean, or scripts/verify/check-record.mjs is
#     absent (TASK-045 not merged: fail closed), or it does not report a green
#     record for HEAD. Contract: `node scripts/verify/check-record.mjs <sha>`
#     (the sha is POSITIONAL; its strict parser rejects any `--commit` flag)
#     exits 0 iff a complete, green check record exists for <sha>.
#   - the key path resolves inside this repository (a key there is one
#     `git add -f` away from a commit), or does not exist.
#   - a reference that is not <repo>@sha256:<64 hex> (a tag is mutable; a
#     tag@digest pair is refused too, so what is signed is exactly what is named).
#
# The private key lives in the operator vault and the recovery kit only
# (D R20-D18). This script never copies it and never prints it.
#
# EXIT CODES  0 signed · 1 refused/failed · 2 usage
set -euo pipefail

# syft v1.33.0, digest-pinned (equals scripts/release/lib/tools.mjs; a test asserts it).
SYFT_IMAGE="mirror.gcr.io/anchore/syft@sha256:f94e5d9fce1f2278491a8e3a63bd5f6ddb81fdfdbb8bf7a1637565c1d5344357"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK=""

die() { printf 'sign-release: %s\n' "$1" >&2; exit "${2:-1}"; }
usage() {
    printf 'usage: sign-release.sh --key <cosign.key> <repo>@sha256:<64 hex>...\n' >&2
    exit 2
}
cleanup() { if [[ -n "$WORK" ]]; then rm -rf -- "$WORK"; fi; }

# no_tlog <output> — cosign v2 prints "tlog entry created with index" when it
# uploads to Rekor. --tlog-upload=false must mean none, so any mention fails.
no_tlog() {
    if grep -qiE 'tlog|rekor|transparency' <<< "$1"; then
        printf '%s\n' "$1" >&2
        die "cosign output mentions a transparency log — refusing (key-based, no public tlog)"
    fi
}

main() {
    local key="" refs=()
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --key) [[ $# -ge 2 ]] || usage; key="$2"; shift 2 ;;
            -h|--help) usage ;;
            -*) usage ;;
            *) refs+=("$1"); shift ;;
        esac
    done
    [[ -n "$key" ]] || usage
    [[ ${#refs[@]} -ge 1 ]] || usage
    [[ -v COSIGN_PASSWORD ]] \
        || die "COSIGN_PASSWORD is not set: cosign would prompt for it where this script hides its output. Run it through cut-dist-tag.sh with COSIGN_PASSWORD_FILE=<file> (an empty COSIGN_PASSWORD for a key without a password)"

    command -v cosign >/dev/null 2>&1 || die "cosign not on PATH"
    command -v docker >/dev/null 2>&1 || die "docker not on PATH (syft runs as a pinned container)"
    command -v jq >/dev/null 2>&1 || die "jq not on PATH"
    command -v node >/dev/null 2>&1 || die "node not on PATH (check-record.mjs)"

    local root head record status
    root="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)" || die "not inside a git checkout"
    head="$(git -C "$root" rev-parse --verify HEAD)"
    # Captured first: inside [[ -z "$(…)" ]] a failing `git status` would read as clean.
    status="$(git -C "$root" status --porcelain)" || die "git status failed"
    [[ -z "$status" ]] \
        || die "working tree is not clean — the check record must describe exactly what is signed"

    record="$root/scripts/verify/check-record.mjs"
    [[ -f "$record" ]] \
        || die "scripts/verify/check-record.mjs absent (TASK-045) — refusing to sign without a check record"
    node "$record" "$head" >&2 \
        || die "no green check record for HEAD ${head} — refusing to sign"

    [[ -f "$key" ]] || die "key not found: $key"
    local key_abs root_abs
    key_abs="$(realpath -e -- "$key")"
    root_abs="$(realpath -e -- "$root")"
    case "$key_abs/" in
        "$root_abs"/*) die "key path $key_abs is inside the repository $root_abs — keep it in the vault" ;;
    esac

    local ref
    for ref in "${refs[@]}"; do
        [[ "$ref" =~ ^[a-z0-9][a-z0-9._/-]*(:[0-9]+)?(/[a-z0-9._-]+)+@sha256:[0-9a-f]{64}$ ]] \
            || die "not a digest reference (<repo>@sha256:<64 hex>, no tag): $ref"
    done

    WORK="$(mktemp -d)"
    trap cleanup EXIT
    cosign public-key --key "$key" > "$WORK/cosign.pub" 2>/dev/null \
        || die "cannot derive the public key from $key (wrong COSIGN_PASSWORD?)"

    # Every SBOM is produced and checked BEFORE the first signature is pushed,
    # so a syft failure on image N cannot leave images 1..N-1 signed but
    # unattested.
    local out sbom n_comp i=0
    local -a comps=()
    for ref in "${refs[@]}"; do
        i=$(( i + 1 ))
        sbom="$WORK/sbom-${i}.cdx.json"
        docker run --rm --network host \
            -v "${DOCKER_CONFIG:-$HOME/.docker}:/config:ro" -e DOCKER_CONFIG=/config \
            -e SYFT_CHECK_FOR_APP_UPDATE=false \
            "$SYFT_IMAGE" -q "registry:${ref}" -o cyclonedx-json@1.6 > "$sbom" \
            || die "syft could not produce an SBOM for $ref (nothing signed)"
        jq -e '.bomFormat == "CycloneDX" and .specVersion == "1.6"' "$sbom" >/dev/null \
            || die "SBOM for $ref is not CycloneDX 1.6 (nothing signed)"
        n_comp="$(jq '[.components // [] | .[]] | length' "$sbom")"
        [[ "$n_comp" -ge 1 ]] || die "SBOM for $ref lists no components (nothing signed)"
        comps+=("$n_comp")
    done

    i=0
    for ref in "${refs[@]}"; do
        i=$(( i + 1 ))
        sbom="$WORK/sbom-${i}.cdx.json"
        out="$(cosign sign --key "$key" --tlog-upload=false --yes "$ref" 2>&1)" \
            || { printf '%s\n' "$out" >&2; die "cosign sign failed for $ref"; }
        no_tlog "$out"
        printf 'SIGNED %s\n' "$ref"

        out="$(cosign attest --key "$key" --type cyclonedx --predicate "$sbom" \
                  --tlog-upload=false --yes "$ref" 2>&1)" \
            || { printf '%s\n' "$out" >&2; die "cosign attest failed for $ref"; }
        no_tlog "$out"

        # Post-conditions in the registry, against the key's own public half.
        cosign verify --key "$WORK/cosign.pub" --insecure-ignore-tlog=true "$ref" >/dev/null 2>&1 \
            || die "post-condition: the signature on $ref does not verify"
        cosign verify-attestation --key "$WORK/cosign.pub" --type cyclonedx \
            --insecure-ignore-tlog=true "$ref" >/dev/null 2>&1 \
            || die "post-condition: the SBOM attestation on $ref does not verify"
        printf 'ATTESTED %s cyclonedx 1.6 components=%s\n' "$ref" "${comps[$(( i - 1 ))]}"
    done
    printf 'sign-release: %d image(s) signed and attested for %s\n' "${#refs[@]}" "$head"
}

main "$@"
