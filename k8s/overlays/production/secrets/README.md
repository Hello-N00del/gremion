# Production Secrets

All secret files in this directory must be SOPS-encrypted before committing.

## Setup (one-time per operator workstation)

Use the bootstrap script — it generates the age key, prints the public key to
paste into `.sops.yaml`, and walks through the operator-vault handoff:

```bash
bash k8s/overlays/production/secrets/bootstrap-sops.sh
```

The script:
1. Installs nothing; verifies `age`, `age-keygen`, and `sops` are on PATH.
2. Generates an age key at `~/.config/sops/age/keys.txt` (chmod 600) if absent.
3. Prints the public half — paste it into the project-root `.sops.yaml`
   replacing the `<OPERATOR_AGE_PUBLIC_KEY_REPLACE_VIA_BOOTSTRAP_SOPS_SH>`
   sentinel.
4. Walks you through uploading the private half to the operator vault
   (1Password / Bitwarden) and confirming an end-to-end encrypt/decrypt
   round trip with the templates in this directory.

DO NOT commit `~/.config/sops/age/keys.txt`. It is the private half.

## Per-service secret templates

Every Secret listed below has a document in `_templates.example.yaml`. To
generate the encrypted version for production:

```bash
# 1. Copy the relevant document out of _templates.example.yaml:
yq 'select(.metadata.name == "postgres-secret")' \
  k8s/overlays/production/secrets/_templates.example.yaml \
  > k8s/overlays/production/secrets/postgres-secret.yaml

# 2. Edit and replace every <PLACEHOLDER> with a real value.

# 3. Encrypt all freshly-filled plaintext files in one pass:
bash k8s/overlays/production/secrets/encrypt-all.sh

# 4. Commit only the .enc.yaml file (plaintext .yaml is gitignored).
```

## Per-service secret files

Each service has its own encrypted secret file:

| File | Service | Keys |
|------|---------|------|
| `postgres-secret.enc.yaml` | postgres | POSTGRES_USER, POSTGRES_PASSWORD, NEXTCLOUD_DB_USER, NEXTCLOUD_DB_PASSWORD, NEXTCLOUD_DB_NAME, KEYCLOAK_DB_USER, KEYCLOAK_DB_PASSWORD, KEYCLOAK_DB_NAME, CONTROL_DB_USER, CONTROL_DB_PASSWORD, CONTROL_DB_NAME |
| `redis-secret.enc.yaml` | redis | REDIS_PASSWORD |
| `nextcloud-secret.enc.yaml` | nextcloud | POSTGRES_PASSWORD, NEXTCLOUD_ADMIN_USER, NEXTCLOUD_ADMIN_PASSWORD, REDIS_HOST_PASSWORD, NEXTCLOUD_OIDC_CLIENT_SECRET, SMTP_PASSWORD |
| `keycloak-secret.enc.yaml` | keycloak | KC_BOOTSTRAP_ADMIN_USERNAME, KC_BOOTSTRAP_ADMIN_PASSWORD, KC_DB_PASSWORD, KC_DB_USERNAME, GREMION_UI_OIDC_CLIENT_SECRET, GREMION_ADMIN_OIDC_CLIENT_SECRET (both required by the `substitute-realm-secrets` initContainer) |
| `gremion-ui-secret.enc.yaml` | gremion-ui | AUTH_SECRET, AUTH_KEYCLOAK_SECRET, KEYCLOAK_ADMIN_CLIENT_SECRET, CONTROL_DATABASE_URL, TENANT_PROXY_SHARED_SECRET (P2.1c T5 — MUST equal the value patched into the `gremion-ui-proxytrust` Middleware header in `patches/ingressroutes-prod.yaml`) |
| `synapse-secret.enc.yaml` | synapse | SYNAPSE_SERVER_NAME, SYNAPSE_REPORT_STATS, POSTGRES_PASSWORD, MACAROON_SECRET_KEY, REGISTRATION_SHARED_SECRET, FORM_SECRET |
| `helios-secret.enc.yaml` | helios | SECRET_KEY, DATABASE_URL, EMAIL_HOST_PASSWORD, HELIOS_ADMIN_PASSWORD |
| `backup-secret.enc.yaml` | backup | BACKUP_ENCRYPTION_KEY (generate: `openssl rand -hex 32`) |
| `legal-config.enc.yaml` | legal | All keys from legal/legal.env.example |

## Encrypt a secret

```bash
# Create plaintext file first (never commit without encrypting)
cat > k8s/overlays/production/secrets/postgres-secret.yaml <<EOF
apiVersion: v1
kind: Secret
metadata:
  name: postgres-secret
stringData:
  POSTGRES_USER: your-user
  POSTGRES_PASSWORD: your-password
  # ... etc
EOF

# Encrypt
sops --encrypt k8s/overlays/production/secrets/postgres-secret.yaml \
  > k8s/overlays/production/secrets/postgres-secret.enc.yaml

# Delete plaintext
rm k8s/overlays/production/secrets/postgres-secret.yaml
```

## Apply

```bash
# Decrypt and apply (requires SOPS key in environment)
kubectl apply -k k8s/overlays/production
```
