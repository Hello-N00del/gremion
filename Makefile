.PHONY: up down build rebuild logs ps setup gen-realm dev-networks lint-pooled-stack \
        shell-kc shell-db \
        keycloak-configure dev-configure dev-ui fresh-start \
        update-legal update-legal-k8s \
        test test-unit test-host-docker test-integration test-all test-ports-nats \
        lint lint-sh lint-yaml lint-json lint-compose \
        lint-hygiene lint-cve-floors lint-packages lint-port-back lint-postgres-major lint-extraction-source \
        lint-unshipped-migrations lint-toolchain lint-compliance lint-tenant-db-access fresh-init-proof \
        verify \
        health validate-env

# ── Service lifecycle ────────────────────────────────────────────────────
#
# Two compose projects since TASK-040 (the pooled stack, PRD-PLAT-005), both
# on the loopback-only dev ports they always had (Q6):
#   $(DEV_STACK)-state     docker-compose.yml + docker-compose.override.yml
#                          (auto-loaded), COMPOSE_PROFILES from .env (dev)
#   $(DEV_STACK)-app-blue  docker-compose.app.yml + docker-compose.app.dev.yml
# They meet only on the external $(DEV_STACK)_state / $(DEV_STACK)_edge
# networks and share the external config volumes: dev-networks creates all of
# them first (the host's bootstrap.sh stage_networks does the same there).
DEV_STACK ?= dev
DEV_STATE = STACK=$(DEV_STACK) IMAGE_TAG=dev docker compose -p $(DEV_STACK)-state
DEV_APP = STACK=$(DEV_STACK) COLOUR=blue IMAGE_TAG=dev docker compose -f docker-compose.app.yml -f docker-compose.app.dev.yml -p $(DEV_STACK)-app-blue

# The externals both projects name; idempotent.
dev-networks:
	@for n in edge state; do \
	   docker network inspect $(DEV_STACK)_$$n >/dev/null 2>&1 || docker network create $(DEV_STACK)_$$n >/dev/null; \
	 done
	@for v in traefik_acme config_data tenant_config_data; do \
	   docker volume inspect $(DEV_STACK)_$$v >/dev/null 2>&1 || docker volume create $(DEV_STACK)_$$v >/dev/null; \
	 done

# Start all services: state first, then the blue app colour
up: dev-networks
	$(DEV_STATE) up -d
	$(DEV_APP) up -d

# Stop all services (keep volumes): app first, then state
down:
	$(DEV_APP) down
	$(DEV_STATE) down

# Build custom images (tagged dev)
build:
	$(DEV_STATE) build
	$(DEV_APP) build

# Rebuild and restart
rebuild: build dev-networks
	$(DEV_STATE) up -d --force-recreate
	$(DEV_APP) up -d --force-recreate

# Rebuild and restart the legal service only — picks up legal/legal.env changes (~2s)
update-legal:
	$(DEV_STATE) up -d --build --force-recreate legal

# Update legal pages in Kubernetes.
# IMPORTANT: re-applies Secret first — rollout restart alone serves stale values.
update-legal-k8s:
	@test -f legal/legal.env || (echo "ERROR: legal/legal.env not found. Copy from legal/legal.env.example" && exit 1)
	kubectl create secret generic legal-config \
	  --from-env-file=legal/legal.env \
	  --dry-run=client -o yaml | kubectl apply -f - -n gremion-system
	kubectl rollout restart deployment/legal -n gremion-system
	@echo "Monitoring rollout..."
	kubectl rollout status deployment/legal -n gremion-system

# Follow logs (SERVICE=gremion-ui|gremion-public|migrate|tenant-create reads
# the app colour, any other SERVICE the state project; none follows both).
logs:
	@case "$(SERVICE)" in \
	   gremion-ui|gremion-public|migrate|tenant-create) $(DEV_APP) logs -f $(SERVICE) ;; \
	   "") $(DEV_STATE) logs -f & $(DEV_APP) logs -f; wait ;; \
	   *) $(DEV_STATE) logs -f $(SERVICE) ;; \
	 esac

# Show running containers of both projects
ps:
	$(DEV_STATE) ps
	$(DEV_APP) ps

# First-time setup: generate secrets and start services
setup:
	@bash scripts/setup.sh

# B-01: this writes the module-composed realm TEMPLATE to
# docker/keycloak/realm-export.json (gitignored). Nothing imports it at boot.
# Target a specific vertical: `CONFIG_PATH=/path/to/config.json make gen-realm`.
gen-realm:
	@test -n "$$CONFIG_PATH" -o -f config/config.json || { echo "gen-realm: set CONFIG_PATH=/path/to/config.json (or add config/config.json) to target a vertical" >&2; exit 1; }
	pnpm -C gremion-ui exec tsx scripts/gen-realm-export.ts

# ── Shell access ─────────────────────────────────────────────────────────

shell-kc:
	$(DEV_STATE) exec keycloak bash

shell-db:
	$(DEV_STATE) exec postgres psql -U postgres

# ── App helpers ──────────────────────────────────────────────────────────

# Configure Keycloak OIDC client secrets after first start
keycloak-configure:
	@bash scripts/configure-keycloak-clients.sh

# Configure dev environment: patches gremion-ui/.env.local + Keycloak redirect URIs
# Run once after `make up` before starting the Vite dev server
dev-configure:
	@bash scripts/dev-configure.sh

# Start the Vite dev server (after dev-configure)
dev-ui:
	@cd gremion-ui && npm run dev

# fresh-start.sh has been retired. Seeding is now done via POST /api/setup/seed.
# After `make up`, run:
#   curl -X POST -H "X-Seed-Token: $SEED_TOKEN" http://localhost:3001/api/setup/seed
fresh-start:
	@echo "fresh-start.sh has been retired. Seed via POST /api/setup/seed instead."
	@echo "  curl -X POST -H \"X-Seed-Token: \$$SEED_TOKEN\" http://localhost:3001/api/setup/seed"
	@exit 1

# ── Testing ──────────────────────────────────────────────────────────────

# BATS is an EXTERNAL prerequisite, not vendored (see docs/TESTING.md).
# Install once: npm install -g bats   (or apt/brew install bats)
BATS := bats

# Run unit tests (no running containers needed)
#
# Globbed, not listed. A bats file nobody names is a bats file nobody runs --
# the same defect the test-ports-nats comment below records. test/*.bats is the
# kernel suite and test/host/*.bats the distribution-host suite;
# test/integration/ is a subdirectory and is deliberately NOT matched, because
# it needs a running stack. test/host/no-host-literals.bats asserts this recipe
# still collects every file under test/host, so reverting to an explicit list
# cannot quietly drop one.
test-unit:
	@echo "Running unit tests..."
	@$(BATS) test/*.bats test/host/*.bats

# Optional LOCAL runner for the distribution-host suite, in the Linux image
# test/host/runner/Dockerfile builds. CI and the Debian host run `test-unit`
# directly and never need this target.
#
# It exists because `make test-unit` cannot run on a Windows development box at
# all: the npm bats shim is handed the C:/ path the recipe's shell reports as
# its cwd and rejects it as "not an absolute path". The container is also where
# the suite's 0600/0700 and executable-bit assertions run for real -- on NTFS
# they would skip. On Windows, prefix the invocation with MSYS_NO_PATHCONV=1 so
# the /wt mount target is not rewritten into a drive path.
#
# Run it from a real clone, not from a `git worktree`: a linked worktree's .git
# is a FILE whose gitdir line is a host-absolute path, which the container
# cannot resolve, and test/host/no-host-literals.bats is built on git grep.
#
# Scope is test/host/*.bats, which is what the image is provisioned for. The
# kernel suites under test/*.bats also need python3 (test/configure-keycloak.bats
# validates realm-export.base.json with `python3 -m json.tool`); they run under
# `make test-unit` on Debian and in CI, where python3 is present.
test-host-docker:
	@echo "Building the bats runner image..."
	@docker build -q -t gremion-bats:local test/host/runner
	@docker run --rm -v "$(CURDIR):/wt" -w /wt gremion-bats:local test/host/*.bats

# Run integration tests (requires running stack: make up or make setup + phases)
test-integration:
	@echo "Running integration tests (requires running stack)..."
	@$(BATS) test/integration/health.bats test/integration/oidc.bats test/integration/legal.bats \
		test/integration/login-theme.bats

# Fresh init on a THROWAWAY Postgres: applies the whole kernel chain and asserts
# tables, a column, a CHECK definition and the public-reader grants IN THE
# DATABASE. Needs docker, nothing else - not the running stack.
fresh-init-proof:
	@echo "Proving a fresh init of the kernel migration chain..."
	@bash gremion-ui/scripts/fresh-init-proof.sh

# Run all tests (unit only by default; use test-all for integration too)
test: test-unit

# Run all tests including integration (alias). test-ports-nats is IN here on
# purpose: a target nothing aggregates is a target nobody runs, which is how the
# JetStream proofs went unexecuted in the first place (integration defect D8).
test-all: test-unit test-integration test-ports-nats

# @gremion/ports against a REAL NATS JetStream server. Starts a throwaway
# container, runs the suite against it, tears it down, and ASSERTS the
# JetStream file actually ran -- vitest exits 0 on a fully skipped file, so the
# exit code alone cannot tell a passing proof from a skipped one.
test-ports-nats:
	@echo "Running @gremion/ports against a real NATS JetStream server..."
	@bash packages/ports/scripts/nats-test.sh

# ── Linting ──────────────────────────────────────────────────────────────

# Lint shell scripts with shellcheck.
# packages/ports/scripts/nats-test.sh is listed explicitly: it lives outside
# scripts/, so the glob above never saw it and the one script that gates the
# JetStream proofs was the one script nothing linted.
# gremion-ui/scripts/hooks/pre-commit likewise: it is EXTENSIONLESS (git requires
# that name) and lives under gremion-ui/, so neither `scripts/*.sh` nor a `.sh`
# glob ever matched it — the one shell file that runs on every commit, and that
# must fail closed, was unlinted. -s sh because it has no `.sh` suffix for
# shellcheck to infer the dialect from.
#
# infra/host/** and test/host/integration/*.sh are the distribution-host
# tooling. FOUR directories, not three: lib/ (common.sh), mail/
# (provision-roles.sh), ops/ (the ops project's scripts) and bin/. ops/ is
# spelled out because it is the one that is easiest to leave out --
# test/host/no-host-literals.bats derives its expected file list from
# `git ls-files -- infra/host test/host`, so a directory missing from this
# recipe fails that test rather than going quiet. bin/gremion-* is
# EXTENSIONLESS on purpose (these are commands on the host's PATH, not
# libraries), so no `.sh` glob will ever match them -- hence the separate
# -s bash arm.
#
# The host arms are a `for` loop, not a bare argument list, for one reason: a
# glob that matches nothing is passed through literally by sh, and shellcheck
# then fails on a filename that does not exist. infra/host/ops/ is written by a
# task that has not landed yet, so the literal-glob form would fail the lint
# today and the directory would have to be added later -- which is exactly the
# "a file nothing lints" defect this target already records twice.
#
# --source-path=SCRIPTDIR lets -x resolve each script's
# `. "$SCRIPT_DIR/../lib/common.sh"` relative to the script rather than to the
# caller's working directory, so `make lint-sh` gives the same answer from
# anywhere. .bats files are deliberately NOT linted here: bats' own idioms
# (`run`, single-quoted shim bodies) raise SC2016/SC2314 infos by design, and
# one file-level decision beats a scattering of inline disables.
# docker/legal/entrypoint.sh is added here because ci.yml linted it and the
# Makefile did not; ci.yml now calls this target, and the unification must not
# lose a file.
lint-sh:
	@echo "Linting shell scripts..."
	@shellcheck -x scripts/*.sh ops/scripts/*.sh docker/postgres/init-databases.sh docker/legal/entrypoint.sh packages/ports/scripts/nats-test.sh
	@shellcheck -x -s sh gremion-ui/scripts/hooks/pre-commit
	@shellcheck -x modules/messaging/synapse/*.sh modules/messaging/synapse/postgres-init/*.sh modules/messaging/synapse/test/*.sh
	@for f in infra/host/bootstrap.sh infra/host/lib/*.sh infra/host/mail/*.sh infra/host/ops/*.sh test/host/integration/*.sh; do \
		[ -e "$$f" ] || continue; \
		shellcheck -x --source-path=SCRIPTDIR "$$f" || exit 1; \
	done
	@for f in infra/host/bin/gremion-*; do \
		[ -e "$$f" ] || continue; \
		shellcheck -x -s bash --source-path=SCRIPTDIR "$$f" || exit 1; \
	done
	@echo "  shellcheck: OK"

# Lint YAML files with yamllint
lint-yaml:
	@echo "Linting YAML files..."
	@yamllint -c .yamllint.yml docker-compose.yml docker-compose.override.yml docker-compose.app.yml docker-compose.app.dev.yml k8s/
	@echo "  yamllint: OK"

# Validate JSON files
lint-json:
	@echo "Validating JSON files..."
	@python3 -m json.tool docker/keycloak/realm-export.base.json > /dev/null
	@echo "  realm-export.base.json: valid"

# Validate Docker Compose config
lint-compose:
	@echo "Validating Docker Compose config..."
	@docker compose config > /dev/null
	@echo "  docker compose config: valid"

# TASK-040: the pooled-stack guard (TRD-177/038/045, TRD-440's static half).
# Renders the state project, both app colours, ops and mail from the fixed
# env files under test/host/fixtures/pooled-stack/ with EVERY profile on and
# fails on a service without a memory or CPU limit, an app-tier volume that is
# not external, a service outside the placement table, a non-council service
# sharing a network with ${STACK}_state, and zero services. The suite runs
# first and must collect tests: a renderer that silently returned an empty
# document would let every rule pass vacuously. TASK-053 wires `verify`.
lint-pooled-stack:
	@echo "Checking the pooled stack..."
	@out=$$(node --test --test-reporter=tap scripts/check-pooled-stack.test.mjs 2>&1); status=$$?; \
	 printf '%s\n' "$$out" | grep -E '^(not ok|# (tests|pass|fail))' >&2; \
	 [ "$$status" -eq 0 ] || exit "$$status"; \
	 n=$$(printf '%s\n' "$$out" | tr -d '\r' | sed -n 's/^# tests \([0-9][0-9]*\)$$/\1/p' | tail -n1); \
	 [ -n "$$n" ] && [ "$$n" -gt 0 ] || { echo "lint-pooled-stack: the suite collected no tests" >&2; exit 1; }
	@node scripts/check-pooled-stack.mjs

# Run all linters
# Kernel repo hygiene: dead workspace globs, floating :latest image tags,
# kustomize buildability, stale onboarding prose, .github completeness.
# Asserts post-conditions (rendered output, file content), never exit codes.
lint-hygiene:
	@echo "Checking kernel hygiene..."
	@node scripts/kernel-hygiene-check.mjs

# CVE override floors: every advisory floor in pnpm-workspace.yaml is held at or
# above its committed first-patched version, the lockfile has absorbed the
# override (an unabsorbed override is INERT — the tree was resolved against
# something else), the resolved tree honours it, no replacement is unbounded,
# and both app manifests stay in @sveltejs/kit lockstep.
# The suite runs first: a parser that silently returned [] would let the guard
# pass vacuously, so the guard's own RED cases are proven on every lint.
lint-cve-floors:
	@echo "Checking CVE override floors..."
	@node --test scripts/check-cve-floors.test.mjs
	@node scripts/check-cve-floors.mjs

# D-01: the three handover migrations ship in NO release-1 tree. The suite runs
# first so the guard's own RED cases (planted file, renumbered file, empty tree)
# are proven on every lint - a walker that silently returned [] would let this
# pass vacuously.
lint-unshipped-migrations:
	@echo "Checking that no handover migration ships..."
	@node --test scripts/check-unshipped-migrations.test.mjs
	@node scripts/check-unshipped-migrations.mjs

# The npm `files` allowlist has to agree with each package's own exports, or a
# published tarball (and, worse, the `pnpm deploy` payload both runtime images
# are built from) ships a package with no entry points. scripts/check-shipped-package-files.mjs
# says in its own header that "both halves live in one script so the rule has
# one home", and .github/PULL_REQUEST_TEMPLATE.md asks contributors to tick
# "`make lint` — no errors" — but the rule fired only in ci.yml, so a local
# `make lint` was green on exactly the class of change the guard exists for.
# --static is the cheap half; --deploy <dir> needs a real pnpm deploy payload
# and stays in CI.
lint-packages:
	@echo "Checking package files allowlists..."
	@node scripts/check-shipped-package-files.mjs --static

# B3 (spec B §A.1): kernel-wins is the decided direction for every
# MIRRORED-but-differing path, and this is the guard that makes it safe — no
# port-back step may delete a path the kernel holds and the StuRa tree does
# not, or overwrite a kernel-ahead path with the extraction source's bytes.
# Run it AFTER the port-back has written and before the branch is handed on:
# it reads the working tree as well as the index, so it sees an unstaged
# `cp -r`/`rsync` — a run before the write only reports the state inherited.
# The suite runs first for the same reason lint-cve-floors runs its suite
# first: a loader that silently returned an empty set would pass vacuously,
# and the set is checked against its own declared entry count for that reason.
lint-port-back:
	@echo "Checking the do-not-overwrite set..."
	@node --test scripts/port-back/check-do-not-overwrite.test.mjs
	@node scripts/port-back/check-do-not-overwrite.mjs

# Postgres major (spec B P3, unit B37): the pinned major is the newest every
# consumer supports; spike S14's evidence lives in docs/ops/postgres-major.md and
# scripts/check-postgres-major.mjs is its machine-readable half. The guard
# refuses an EMPTY match set, so a scan that found nothing fails instead of
# passing vacuously. The suite runs first, for the same reason check-cve-floors'
# does: a parser that silently returned [] would make the guard green on every
# tree.
lint-postgres-major:
	@echo "Checking the Postgres major pin..."
	@node --test scripts/check-postgres-major.test.mjs
	@node --test scripts/check-postgres-major-running.test.mjs
	@node scripts/check-postgres-major.mjs

# The split extracts ten module repositories from ONE commit of the StuRa tree.
# The SHA is recorded once (docs/ops/extraction-source.md) and echoed by every
# module.json; two module.json that disagree mean the extraction straddled two
# source states, which nothing else in the build would notice. The suite runs
# first, for the same reason lint-cve-floors runs its own: a collector that
# silently returned [] would let the guard pass vacuously, so the guard's RED
# cases are proven on every lint. The committed fixture pair is passed as
# --modules-root so the agreement arm is non-vacuous here too.
#
# The suite's own count is asserted, because `node --test <file>` exits 0 on a
# file that collects NO tests -- it reports the file itself as `1..1`, so
# neither the exit code nor a merely non-zero TAP plan can tell a real run from
# a suite that stopped registering. So: count the top-level `test(`
# declarations, read the TAP plan node actually ran, and refuse unless they are
# equal and non-zero. If the suite is ever restructured so its tests no longer
# start at column 0, this fails loudly and the count here must be moved
# deliberately -- it must never degrade to silence.
lint-extraction-source:
	@echo "Checking the frozen extraction source..."
	@declared=$$(grep -c '^test(' scripts/check-extraction-source.test.mjs); \
	 out=$$(node --test --test-reporter=tap scripts/check-extraction-source.test.mjs 2>&1); \
	 status=$$?; \
	 printf '%s\n' "$$out" >&2; \
	 [ "$$status" -eq 0 ] || exit "$$status"; \
	 collected=$$(printf '%s\n' "$$out" | tr -d '\r' | sed -n 's/^1\.\.\([0-9][0-9]*\)$$/\1/p' | tail -n1); \
	 if [ "$$declared" -lt 1 ]; then \
	   echo "lint-extraction-source: scripts/check-extraction-source.test.mjs declares no top-level test() -- the suite collects nothing and would still exit 0." >&2; \
	   exit 1; \
	 fi; \
	 if [ "$$collected" != "$$declared" ]; then \
	   echo "lint-extraction-source: the suite declares $$declared test(s) but node ran '$$collected'." >&2; \
	   echo "  Either tests stopped registering, or they no longer start at column 0 -- in which case move this count deliberately." >&2; \
	   exit 1; \
	 fi; \
	 echo "[extraction-source] suite: $$collected of $$declared declared test(s) ran"
	@node scripts/check-extraction-source.mjs --modules-root test/fixtures/extraction-source/agree

# TASK-017 (TRD-400/401/402): Node major, the pnpm build-script allow-list,
# first-party lifecycle scripts and strict TS, all in one guard. NOT wired
# into the `lint` aggregate below — TASK-045 (scripts/verify/**) owns that
# wiring per post-condition "Guard callable by verify; its suite runs first".
# The suite's own test count is asserted the same way lint-extraction-source
# does: `node --test` exits 0 on a file that collects zero tests, so the
# collector's own TAP plan is checked against its declared `test(` count.
lint-toolchain:
	@echo "Checking the pinned toolchain (Node major, build allow-list, TS strictness)..."
	@declared=$$(grep -c '^test(' scripts/check-toolchain.test.mjs); \
	 out=$$(node --test --test-reporter=tap scripts/check-toolchain.test.mjs 2>&1); \
	 status=$$?; \
	 printf '%s\n' "$$out" >&2; \
	 [ "$$status" -eq 0 ] || exit "$$status"; \
	 collected=$$(printf '%s\n' "$$out" | tr -d '\r' | sed -n 's/^1\.\.\([0-9][0-9]*\)$$/\1/p' | tail -n1); \
	 if [ "$$declared" -lt 1 ]; then \
	   echo "lint-toolchain: scripts/check-toolchain.test.mjs declares no top-level test() -- the suite collects nothing and would still exit 0." >&2; \
	   exit 1; \
	 fi; \
	 if [ "$$collected" != "$$declared" ]; then \
	   echo "lint-toolchain: the suite declares $$declared test(s) but node ran '$$collected'." >&2; \
	   exit 1; \
	 fi; \
	 echo "[toolchain] suite: $$collected of $$declared declared test(s) ran"
	@node scripts/check-toolchain.mjs

# TASK-022: the ACME edge render guard (scripts/check-compose-edge.test.mjs).
# Renders the production composition with the fixed fixture
# test/host/fixtures/edge-render/state.env and asserts the bind addresses,
# the static file and the service shape. Needs docker (compose config only,
# never `up`). The suite's collected count is asserted against its declared
# `test(` count, for the reason lint-extraction-source gives -- and because
# this suite registers its tests only when it is the process entry (it is
# imported by TASK-034), so a runner that stopped making it the entry would
# collect zero. NOT wired into the `lint` aggregate: TASK-045 owns that.
.PHONY: lint-edge-render test-edge-static lint-js
lint-edge-render:
	@echo "Checking the ACME edge render..."
	@declared=$$(grep -c '^test(' scripts/check-compose-edge.test.mjs); \
	 out=$$(node --test --test-reporter=tap scripts/check-compose-edge.test.mjs 2>&1); \
	 status=$$?; \
	 printf '%s\n' "$$out" >&2; \
	 [ "$$status" -eq 0 ] || exit "$$status"; \
	 collected=$$(printf '%s\n' "$$out" | tr -d '\r' | sed -n 's/^1\.\.\([0-9][0-9]*\)$$/\1/p' | tail -n1); \
	 if [ "$$declared" -lt 1 ]; then \
	   echo "lint-edge-render: scripts/check-compose-edge.test.mjs declares no top-level test() -- the suite collects nothing and would still exit 0." >&2; \
	   exit 1; \
	 fi; \
	 if [ "$$collected" != "$$declared" ]; then \
	   echo "lint-edge-render: the suite declares $$declared test(s) but node ran '$$collected'." >&2; \
	   exit 1; \
	 fi; \
	 echo "[edge-render] suite: $$collected of $$declared declared test(s) ran"

# TASK-041 (L3-08; TRD-074/075): the edge host-model guard
# (scripts/check-edge-host-model.test.mjs). Under whole-host resolution no
# router may carry a HostRegexp leg (bar the two loopback internaltest routers
# pinned by value), the wildcard env key, the apex host injection and the
# leftmost-label resolver stay gone. The suite's collected count is asserted
# against its declared `test(` count, as lint-edge-render does, then the guard
# scans the tracked tree. Wired into `lint` and verify carve-lint.
.PHONY: lint-edge-host
lint-edge-host:
	@echo "Checking the edge host model..."
	@declared=$$(grep -c '^test(' scripts/check-edge-host-model.test.mjs); \
	 out=$$(node --test --test-reporter=tap scripts/check-edge-host-model.test.mjs 2>&1); \
	 status=$$?; \
	 printf '%s\n' "$$out" >&2; \
	 [ "$$status" -eq 0 ] || exit "$$status"; \
	 collected=$$(printf '%s\n' "$$out" | tr -d '\r' | sed -n 's/^1\.\.\([0-9][0-9]*\)$$/\1/p' | tail -n1); \
	 if [ "$$declared" -lt 1 ]; then \
	   echo "lint-edge-host: scripts/check-edge-host-model.test.mjs declares no top-level test() -- the suite collects nothing and would still exit 0." >&2; \
	   exit 1; \
	 fi; \
	 if [ "$$collected" != "$$declared" ]; then \
	   echo "lint-edge-host: the suite declares $$declared test(s) but node ran '$$collected'." >&2; \
	   exit 1; \
	 fi; \
	 echo "[edge-host-model] suite: $$collected of $$declared declared test(s) ran"
	@node scripts/check-edge-host-model.mjs

# TASK-022: the scratch-stack proof of the ACME edge (Docker; minutes, not
# seconds -- it waits for a real certificate renewal). Brings up only traefik,
# docker-socket-proxy and a scratch ACME CA under a t022-<sha8> project and
# removes them by name; never `docker compose down`. Then the mechanism proof.
test-edge-static:
	@bash test/host/integration/edge-static.sh
	@bash scripts/verify-traefik-acme-wiring.sh

# R25-2: standalone Oxlint (root .oxlintrc.json), as a RATCHET: fails when the
# error count rises above scripts/lint-js-baseline.json and asks for the
# baseline to be lowered when it falls (scripts/check-lint-js.mjs). Rule-
# specific reasons live in docs/lint.md (JSON has no comments). The verify
# gate runs it (TASK-045 carve-lint). NOT in the `lint` aggregate yet; at
# baseline 0 it becomes a plain zero-error gate and joins it.
lint-js:
	@echo "Linting JS/TS/Svelte with oxlint (ratchet)..."
	@node --test scripts/check-lint-js.test.mjs
	@node scripts/check-lint-js.mjs

# TASK-005 (TRD-265, TRD-112, TRD-268): the marketing-copy check. Copy that
# names a licence-register system with a licence other than its register value,
# or that asserts online student-body elections are lawful / the module fit for
# statutory use, fails. Both rule sets are read from docs/compliance/, and the
# check refuses an empty scope. The two suites run first and their collected
# count is asserted against the declared `test(` count, the same way
# lint-toolchain does: `node --test` exits 0 on a file that collects nothing.
# The Helios bump script's own suite rides here so it runs on every lint even
# though the submodule it guards lives in a consuming repository.
lint-compliance:
	@echo "Checking marketing copy against the licence register and elections scope..."
	@for suite in ops/scripts/marketing-copy-check.test.mjs ops/scripts/helios-submodule-check.test.mjs; do \
	   declared=$$(grep -c '^test(' "$$suite"); \
	   out=$$(node --test --test-reporter=tap "$$suite" 2>&1); \
	   status=$$?; \
	   [ "$$status" -eq 0 ] || { printf '%s\n' "$$out" >&2; exit "$$status"; }; \
	   collected=$$(printf '%s\n' "$$out" | tr -d '\r' | sed -n 's/^1\.\.\([0-9][0-9]*\)$$/\1/p' | tail -n1); \
	   if [ "$$declared" -lt 1 ] || [ "$$collected" != "$$declared" ]; then \
	     echo "lint-compliance: $$suite declares $$declared test(s) but node ran '$$collected'." >&2; \
	     exit 1; \
	   fi; \
	   echo "[compliance] $$suite: $$collected of $$declared declared test(s) ran"; \
	 done
	@node ops/scripts/marketing-copy-check.mjs

# TASK-020 (R25): the tenant-DB access scan -- a direct postgres()/createDb/Pool
# connection outside @gremion/tenant-store fails unless it is on the dated
# allow-list naming its adopting task. Line granted to the orchestrator by the brief.
lint-tenant-db-access:
	@echo "Checking tenant-DB access..."
	@node packages/tenant-store/scripts/check-tenant-db-access.mjs

# TASK-200 (R27 orchestrator grant): the in-tree module guards. lint-module-scan
# refuses a modules/** import, path literal or Dockerfile COPY that leaves its
# own modules/<id>/ (or names upstream/, services/, the StuRa tree, @stura*)
# unless modules' reasoned allowlist names it; lint-module-migration-names
# refuses a module migration basename equal to a kernel gremion-ui/migrations
# one, a number used twice in one chain, and an app-chain number another chain
# already uses. Each suite runs first with its collected count asserted, the
# same way lint-toolchain does: `node --test` exits 0 on a file that collects
# nothing. The source-parity guard is deliberately NOT here (brief TDD 1: it
# needs a StuRa checkout, and modules diverge from the tag by design later).
.PHONY: lint-module-scan lint-module-migration-names
lint-module-scan:
	@echo "Checking in-tree module source for escaping imports..."
	@declared=$(grep -c '^test(' scripts/check-module-source-scan.test.mjs); \
	 out=$(node --test --test-reporter=tap scripts/check-module-source-scan.test.mjs 2>&1); \
	 status=$?; \
	 [ "$status" -eq 0 ] || { printf '%s\n' "$out" >&2; exit "$status"; }; \
	 collected=$(printf '%s\n' "$out" | tr -d '\r' | sed -n 's/^1\.\.\([0-9][0-9]*\)$/\1/p' | tail -n1); \
	 if [ "$declared" -lt 1 ] || [ "$collected" != "$declared" ]; then \
	   echo "lint-module-scan: scripts/check-module-source-scan.test.mjs declares $declared test(s) but node ran '$collected'." >&2; \
	   exit 1; \
	 fi; \
	 echo "[module-source-scan] suite: $collected of $declared declared test(s) ran"
	@node scripts/check-module-source-scan.mjs

lint-module-migration-names:
	@echo "Checking module migration names against the kernel chain..."
	@declared=$(grep -c '^test(' scripts/check-module-migration-names.test.mjs); \
	 out=$(node --test --test-reporter=tap scripts/check-module-migration-names.test.mjs 2>&1); \
	 status=$?; \
	 [ "$status" -eq 0 ] || { printf '%s\n' "$out" >&2; exit "$status"; }; \
	 collected=$(printf '%s\n' "$out" | tr -d '\r' | sed -n 's/^1\.\.\([0-9][0-9]*\)$/\1/p' | tail -n1); \
	 if [ "$declared" -lt 1 ] || [ "$collected" != "$declared" ]; then \
	   echo "lint-module-migration-names: scripts/check-module-migration-names.test.mjs declares $declared test(s) but node ran '$collected'." >&2; \
	   exit 1; \
	 fi; \
	 echo "[module-migration-names] suite: $collected of $declared declared test(s) ran"
	@node scripts/check-module-migration-names.mjs

# TASK-198: the chat module's Synapse. lint-synapse runs the module suites
# (render, refusal, probe, preflight, inject: modules/messaging/synapse/test/) and the
# kernel's static half (scripts/check-synapse-stack.test.mjs: the
# messaging-postgres and matrix render, .env.example with the profile off,
# this wiring), each with its collected count asserted against its declared
# `test(` count -- `node --test` exits 0 on a file that collects nothing --
# then the guard itself. Needs docker (compose config only, never `up`).
# synapse-proof is the scratch-stack proof (TDD 5 and 7), one PHASE per call
# (prepare, names, initdb, a..f, teardown): Docker, minutes, never in `lint`
# or verify. The compose file is passed from here so the module script names
# nothing outside modules/messaging/.
.PHONY: lint-synapse synapse-proof
lint-synapse:
	@echo "Checking the chat module's Synapse..."
	@for suite in modules/messaging/synapse/test/inject.test.mjs modules/messaging/synapse/test/preflight.test.mjs \
	             modules/messaging/synapse/test/probe.test.mjs modules/messaging/synapse/test/refusal.test.mjs \
	             modules/messaging/synapse/test/render.test.mjs \
	             scripts/check-synapse-stack.test.mjs; do \
	   declared=$$(grep -c '^test(' "$$suite"); \
	   out=$$(node --test --test-reporter=tap "$$suite" 2>&1); \
	   status=$$?; \
	   [ "$$status" -eq 0 ] || { printf '%s\n' "$$out" >&2; exit "$$status"; }; \
	   collected=$$(printf '%s\n' "$$out" | tr -d '\r' | sed -n 's/^1\.\.\([0-9][0-9]*\)$$/\1/p' | tail -n1); \
	   if [ "$$declared" -lt 1 ] || [ "$$collected" != "$$declared" ]; then \
	     echo "lint-synapse: $$suite declares $$declared test(s) but node ran '$$collected'." >&2; \
	     exit 1; \
	   fi; \
	   if printf '%s\n' "$$out" | tr -d '\r' | grep -Eq '^# (skipped|todo) [1-9]'; then \
	     echo "lint-synapse: $$suite skipped or left todo test(s) -- the TAP plan would count them as run." >&2; \
	     exit 1; \
	   fi; \
	   echo "[synapse] $$suite: $$collected of $$declared declared test(s) ran"; \
	 done
	@node scripts/check-synapse-stack.mjs

synapse-proof:
	@bash modules/messaging/synapse/test/scratch-proof.sh "$(PHASE)" "$(CURDIR)/docker-compose.yml" "$(CURDIR)/scripts/check-postgres-major-running.mjs"

lint: lint-sh lint-yaml lint-json lint-compose lint-pooled-stack lint-hygiene lint-cve-floors lint-packages lint-port-back lint-postgres-major lint-extraction-source lint-unshipped-migrations lint-compliance lint-tenant-db-access lint-edge-host lint-module-scan lint-module-migration-names lint-synapse
	@echo "All linters passed."

# ── Local gate (TASK-045, TRD-444/341) ──────────────────────────────────────

# The one fail-closed local gate: typecheck, unit, integration, migration-hash
# and carve-lint (scripts/verify/required-suites.txt is the actual list this
# target must not drift from -- scripts/verify/meta.test.mjs asserts the two
# stay in step). Every suite is judged by scripts/verify/lib/guard.mjs, which
# never trusts a tool's exit code alone: a suite that collects zero tests, is
# skipped, or needs a missing tool FAILS here, it does not pass silently the
# way an un-gated `pnpm test` would. Writes scripts/verify/out/<HEAD-sha>.json
# (gitignored); `node scripts/verify/check-record.mjs` reads that record
# without re-running anything and is the actual merge block.
verify:
	@node scripts/verify/verify.mjs

# ── Repository labels ────────────────────────────────────────────────────

# Apply .github/labels.yml to the remote. GitHub silently DROPS a label that
# dependabot.yml references but the repo does not have, so the roster has to be
# applied, not just committed. Idempotent: creates or updates each label.
labels:
	@echo "Applying .github/labels.yml..."
	@python3 -c "import re,sys; \
src=open('.github/labels.yml',encoding='utf-8').read(); \
[print('\t'.join(m)) for m in re.findall(r'- name: (\S+)\n\s+color: \"(\w+)\"\n\s+description: (.+)', src)]" \
	| while IFS=$$'\t' read -r name color desc; do \
		gh label create "$$name" --color "$$color" --description "$$desc" --force; \
	done
	@echo "  labels: applied"

# ── Health & Diagnostics ─────────────────────────────────────────────────

# Check health of all running services
health:
	@echo "=== Service Health ==="
	@$(DEV_STATE) ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}"
	@$(DEV_APP) ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}"
	@echo ""
	@echo "=== Endpoint Checks ==="
	@curl -sf http://localhost:3001/ > /dev/null && echo "  gremion-ui  (3001): OK" || echo "  gremion-ui  (3001): NOT REACHABLE"
	@curl -sf http://localhost:8082/auth/health/ready > /dev/null && echo "  Keycloak  (8082): OK" || echo "  Keycloak  (8082): NOT REACHABLE"
	@curl -sf http://localhost:8083/impressum > /dev/null && echo "  Legal     (8083): OK" || echo "  Legal     (8083): NOT REACHABLE"

# Validate .env has all required variables (no empty CHANGE_ME_ left)
validate-env:
	@echo "Validating .env..."
	@test -f .env || (echo "ERROR: .env not found. Run: make setup" && exit 1)
	@if grep -q "CHANGE_ME_" .env; then \
		echo "ERROR: .env still contains CHANGE_ME_ placeholders:"; \
		grep "CHANGE_ME_" .env; \
		exit 1; \
	fi
	@echo "  .env: OK (no placeholders found)"
	@# The read-only portal role is a BOOT prerequisite, not a nicety:
	@# gremion-ui/migrations/058_public_reader_grants.sql aborts the whole
	@# data-plane chain when gremion_public_reader is missing, and
	@# docker/postgres/init-databases.sh refuses to start without this value.
	@# An empty one here is a stack that comes up and never migrates.
	@grep -qE "^PUBLIC_DB_PASSWORD=.+" .env || (echo "ERROR: PUBLIC_DB_PASSWORD is unset or empty in .env - the gremion_public_reader role cannot be created, and gremion-ui/migrations/058_public_reader_grants.sql aborts the migration chain without it" && exit 1)
	@echo "  public reader: OK (PUBLIC_DB_PASSWORD is set)"
	@# B-01: KEYCLOAK_REALM and the /realms/ segment of AUTH_KEYCLOAK_ISSUER
	@# name ONE realm. Disagreement is silent and is a WRITE — see
	@# scripts/check-realm-env.sh.
	@bash scripts/check-realm-env.sh .env
	@echo "  realm: OK (KEYCLOAK_REALM agrees with AUTH_KEYCLOAK_ISSUER)"
