# infra/hardening/Makefile
#
# Generates the hardening .env from values.yaml via envsubst.
#
# Usage:
#   make hardening-config          # generate .env.hardening from values.yaml
#   make generate-ipcrypt-key      # generate a fresh ipcrypt key in secrets/
#   make rotate-ipcrypt-key        # rotate the ipcrypt key (wraps the shell script)
#   make check                     # run restic check subset against local repo
#   make help                      # print this help

SHELL := /bin/bash
ROOT  := $(shell git rev-parse --show-toplevel)

VALUES     := $(ROOT)/infra/hardening/values.yaml
TMPL       := $(ROOT)/infra/hardening/templates/hardening.env.tmpl
OUT        := $(ROOT)/.env.hardening
SECRETS_DIR := $(ROOT)/secrets

.PHONY: hardening-config generate-ipcrypt-key rotate-ipcrypt-key check help

## Generate .env.hardening from values.yaml + template
hardening-config: $(VALUES) $(TMPL)
	@echo "[hardening] Generating $(OUT)..."
	@# Extract values using python3 (avoid yq dependency)
	@python3 - <<'EOF'
import sys, re, subprocess, os

try:
    import yaml
except ImportError:
    subprocess.check_call([sys.executable, '-m', 'pip', 'install', '--quiet', 'pyyaml'])
    import yaml

with open('$(VALUES)') as f:
    v = yaml.safe_load(f)

r = v['retention']
b = v['backup']
ic = v.get('ipcrypt', {})

env = {
    'LOG_ACCESS_RETENTION_SECONDS': str(r['access_logs_days'] * 86400),
    'LOG_APP_RETENTION_SECONDS':    str(r['app_logs_days'] * 86400),
    'LOG_SEC_RETENTION_SECONDS':    str(r['security_logs_days'] * 86400),
    'LOG_SECNOPII_RETENTION_SECONDS': str(r['security_nopii_logs_days'] * 86400),
    'BACKUP_LOCAL_RETENTION_DAYS':  str(b['local_retention_days']),
    'BACKUP_REMOTE_RETENTION_DAYS': str(b['remote_retention_days']),
    'BACKUP_FINANCIAL_RETENTION_DAYS': str(b['financial_retention_days']),
    'BACKUP_CRON_START':            b['cron_start'],
    'RESTIC_CHECK_SUBSET':          b['restic_check_subset'],
    'IPCRYPT_ROTATION_DAYS':        str(ic.get('rotation_days', 14)),
}

with open('$(TMPL)') as f:
    tmpl = f.read()

for k, val in env.items():
    tmpl = tmpl.replace('$${' + k + '}', val)

with open('$(OUT)', 'w') as f:
    f.write(tmpl)

print(f'[hardening] Written: $(OUT)')
EOF
	@echo "[hardening] Done."

## Generate a fresh ipcrypt key and write to secrets/ipcrypt_key.txt
generate-ipcrypt-key:
	@mkdir -p "$(SECRETS_DIR)"
	@openssl rand -hex 16 > "$(SECRETS_DIR)/ipcrypt_key.txt"
	@echo "1" > "$(SECRETS_DIR)/ipcrypt_epoch.txt"
	@echo "[hardening] Generated new ipcrypt key (epoch 1) in $(SECRETS_DIR)/"
	@echo "[hardening] Add secrets/ to .gitignore and never commit it."

## Rotate ipcrypt key (delegates to scripts/rotate-ipcrypt-key.sh)
rotate-ipcrypt-key:
	@$(ROOT)/scripts/rotate-ipcrypt-key.sh

## Run restic integrity check against local repository
check:
	@source "$(ROOT)/.env" && \
	  RESTIC_REPOSITORY="$${RESTIC_REPOSITORY:-$(ROOT)/backups/repo}" \
	  restic check --read-data-subset="$${RESTIC_CHECK_SUBSET:-10%}"

help:
	@grep -E '^##' $(MAKEFILE_LIST) | sed 's/^## //'
