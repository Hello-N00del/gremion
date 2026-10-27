#!/usr/bin/env bash
# G-037: supply-chain guard for floating :latest image tags in the compose files.
#
# Externally-pulled images in the production compose render must be
# digest-pinned (image: name:tag@sha256:...). The kernel's own images
# (ghcr.io/hello-n00del/gremion-*) may carry a floating tag -- but ONLY because
# they are built here, and this script PROVES that rather than asserting it.
#
# The old exemption was `image: gremion/` with the comment "built from this
# repo and never pulled from a public registry". Both halves were wrong.
# `gremion/ui` is an unqualified name, so Docker resolves it to docker.io/gremion/ui
# -- a Docker Hub namespace owned by an unrelated third party -- and
# `docker compose pull` / `up --pull always` are exactly the commands a
# self-hoster runs. The images are now named under a namespace we control, and
# the exemption is conditional on a `build:` section existing for that service
# in the rendered config.
#
# What is rendered (TASK-040 split the stack into projects, so ONE render no
# longer sees every image):
#   state tier  docker-compose.yml + docker-compose.prod.yml --profile production
#               (legal, vector, fallback; `traefik` lives in the production
#               profile and `cloudflared` depends on it)
#   app tier    docker-compose.app.yml, every profile on
#               (gremion-ui, gremion-public, control-panel, migrate, kernel-api)
# Both are read-only renders (`docker compose config`, never `up`).
#
# Required compose variables that a bare `cp .env.example .env` leaves unset come
# from compose/ci.placeholder.env (render-only, the same file `pnpm check`'s
# port-binding check reads); a value already in the environment wins.
#
# Run from the repository root; needs docker compose, jq, and the stub files
# .env + legal/legal.env (`scripts/setup.sh` writes them; CI copies
# .env.example and touches legal/legal.env).
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

PLACEHOLDERS=compose/ci.placeholder.env
IMAGE_PREFIX='ghcr.io/hello-n00del/gremion-'
# The first-party images the render must name. Each is asserted by NAME, so a
# render that quietly lost one cannot pass on the count of the others.
EXPECTED_IMAGES=(ui public legal vector fallback)

for f in .env legal/legal.env "$PLACEHOLDERS"; do
  if [ ! -e "$f" ]; then
    echo "ERROR: $f is missing -- compose cannot render without it. Run scripts/setup.sh first," >&2
    echo "(CI: cp .env.example .env && mkdir -p legal && touch legal/legal.env). Nothing was verified." >&2
    exit 1
  fi
done

# Fill-if-unset, the same rule gremion-ui/scripts/check-app-port-binding.mjs applies.
while IFS='=' read -r key value; do
  case "$key" in '' | '#'*) continue ;; esac
  value="${value%$'\r'}"
  if [ -z "${!key:-}" ]; then export "$key=$value"; fi
done < "$PLACEHOLDERS"

# App tier: the host pins these per colour; any value renders. IMAGE_TAG comes
# from .env.example (dev) and is not "latest".
state=(docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile production)
app=(docker compose -f docker-compose.app.yml --profile '*')

# One read-only render. stderr is held back: compose's "variable is not set"
# warnings name only optional per-module passwords and would bury the verdict,
# but on a FAILED render the non-warning lines are printed and the guard stops.
render_json() {
  local out err
  err=$(mktemp)
  if ! out=$("$@" config --format json 2> "$err"); then
    grep -v 'level=warning' "$err" >&2 || true
    rm -f "$err"
    echo "ERROR: ${*} config failed -- nothing was verified." >&2
    return 1
  fi
  rm -f "$err"
  printf '%s' "$out"
}

state_json=$(render_json "${state[@]}")
app_json=$(render_json "${app[@]}")
json=$(printf '%s
%s
' "$state_json" "$app_json" | jq -s '{services: (map(.services) | add)}')

# (1) Vacuity guard -- a render that stopped containing our images would turn
# every check below into a silent pass.
first_party=$(echo "$json" | jq --arg p "$IMAGE_PREFIX" '[.services[] | select((.image // "") | startswith($p))] | length')
missing=()
for name in "${EXPECTED_IMAGES[@]}"; do
  if ! echo "$json" | jq -e --arg p "${IMAGE_PREFIX}${name}:" '[.services[] | select((.image // "") | startswith($p))] | length > 0' > /dev/null; then
    missing+=("$name")
  fi
done
if [ "$first_party" -lt "${#EXPECTED_IMAGES[@]}" ] || [ "${#missing[@]}" -gt 0 ]; then
  echo "ERROR: the render names $first_party first-party image(s); missing: ${missing[*]:-none}; expected at least ${#EXPECTED_IMAGES[@]} (${EXPECTED_IMAGES[*]})." >&2
  echo "Either an image was renamed away from ${IMAGE_PREFIX}*, or this guard is reading the wrong render." >&2
  exit 1
fi
echo "Render carries $first_party first-party image(s), including ${EXPECTED_IMAGES[*]}."

# (2) The exemption's premise: every first-party image is BUILT here.
unbuilt=$(echo "$json" | jq -r --arg p "$IMAGE_PREFIX" '.services | to_entries[]
  | select((.value.image // "") | startswith($p))
  | select(.value.build == null)
  | "\(.key): \(.value.image)"')
if [ -n "$unbuilt" ]; then
  echo "ERROR: first-party image(s) with no build: section -- they would be PULLED, so :latest is not safe:" >&2
  echo "$unbuilt" >&2
  exit 1
fi
echo "OK -- every first-party image has a build: section."

# (3) The actual :latest check, exempting only the images just proven to be
# built from this repo. A digest-pinned reference (name:latest@sha256:...) does
# not end in ":latest" and passes.
violators=$(echo "$json" | jq -r --arg p "$IMAGE_PREFIX" '.services | to_entries[]
  | select((.value.image // "") | endswith(":latest"))
  | select(.value.image | startswith($p) | not)
  | "\(.key): \(.value.image)"')
if [ -n "$violators" ]; then
  echo "ERROR: :latest tags on externally-pulled images:" >&2
  echo "$violators" >&2
  echo >&2
  echo "Pin to <tag>@sha256:<digest> -- see G-037 / G-038." >&2
  exit 1
fi
echo "OK -- no externally-pulled :latest images in compose."
