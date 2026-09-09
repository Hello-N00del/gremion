.PHONY: up down build rebuild logs ps setup gen-realm \
        shell-kc shell-db \
        keycloak-configure dev-configure dev-ui fresh-start \
        update-legal update-legal-k8s \
        test test-unit test-integration test-all test-ports-nats \
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
test-unit:
	@echo "Running unit tests..."
	@$(BATS) test/setup.bats test/backup.bats test/restore.bats test/configure-keycloak.bats test/legal.bats

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
lint-sh:
	@echo "Linting shell scripts..."
	@shellcheck scripts/*.sh docker/postgres/init-databases.sh packages/ports/scripts/nats-test.sh
	@shellcheck -s sh gremion-ui/scripts/hooks/pre-commit
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
