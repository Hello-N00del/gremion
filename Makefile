.PHONY: up down build rebuild logs ps setup gen-realm \
        shell-kc shell-db \
        keycloak-configure dev-configure dev-ui fresh-start \
        update-legal update-legal-k8s \
        test test-unit test-host-docker test-integration test-all test-ports-nats \
        lint lint-sh lint-yaml lint-json lint-compose \
        lint-hygiene lint-cve-floors lint-packages \
        health validate-env

# ── Service lifecycle ────────────────────────────────────────────────────

# Start all services
up:
	docker compose up -d

# Stop all services (keep volumes)
down:
	docker compose down

# Build custom images
build:
	docker compose build

# Rebuild and restart
rebuild: build
	docker compose up -d --force-recreate

# Rebuild and restart the legal service only — picks up legal/legal.env changes (~2s)
update-legal:
	docker compose up -d --build --force-recreate legal

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

# Follow logs for all services (or pass SERVICE=gremion-ui)
logs:
	docker compose logs -f $(SERVICE)

# Show running containers
ps:
	docker compose ps

# First-time setup: generate secrets and start services
setup:
	@bash scripts/setup.sh

# Generate docker/keycloak/realm-export.json from the module manifests + the
# target vertical's config (modules.<id> = true/false). Disabled modules
# contribute no groups/roles. Run BEFORE `docker compose up` (Keycloak imports
# the file at boot). REQUIRES a config: reads CONFIG_PATH if set, else
# ./config/config.json; with neither present it errors out (it does not no-op).
# Target a specific vertical: `CONFIG_PATH=/path/to/config.json make gen-realm`.
gen-realm:
	@test -n "$$CONFIG_PATH" -o -f config/config.json || { echo "gen-realm: set CONFIG_PATH=/path/to/config.json (or add config/config.json) to target a vertical" >&2; exit 1; }
	pnpm -C gremion-ui exec tsx scripts/gen-realm-export.ts

# ── Shell access ─────────────────────────────────────────────────────────

shell-kc:
	docker compose exec keycloak bash

shell-db:
	docker compose exec postgres psql -U postgres

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
# validates realm-export.json with `python3 -m json.tool`); they run under
# `make test-unit` on Debian and in CI, where python3 is present.
test-host-docker:
	@echo "Building the bats runner image..."
	@docker build -q -t gremion-bats:local test/host/runner
	@docker run --rm -v "$(CURDIR):/wt" -w /wt gremion-bats:local test/host/*.bats

# Run integration tests (requires running stack: make up or make setup + phases)
test-integration:
	@echo "Running integration tests (requires running stack)..."
	@$(BATS) test/integration/health.bats test/integration/oidc.bats test/integration/legal.bats

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
	@shellcheck -x scripts/*.sh docker/postgres/init-databases.sh docker/legal/entrypoint.sh packages/ports/scripts/nats-test.sh
	@shellcheck -x -s sh gremion-ui/scripts/hooks/pre-commit
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
	@yamllint -c .yamllint.yml docker-compose.yml docker-compose.override.yml k8s/ docker/kustomization.yaml
	@echo "  yamllint: OK"

# Validate JSON files
lint-json:
	@echo "Validating JSON files..."
	@python3 -m json.tool docker/keycloak/realm-export.json > /dev/null
	@echo "  realm-export.json: valid"

# Validate Docker Compose config
lint-compose:
	@echo "Validating Docker Compose config..."
	@docker compose config > /dev/null
	@echo "  docker compose config: valid"

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

lint: lint-sh lint-yaml lint-json lint-compose lint-hygiene lint-cve-floors lint-packages
	@echo "All linters passed."

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
	@docker compose ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}"
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
