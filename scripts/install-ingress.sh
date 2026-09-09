#!/usr/bin/env bash
# ============================================================
# Gremion — Install nginx-ingress + cert-manager
#
# Run this ONCE on a fresh managed Kubernetes cluster before
# applying any Gremion manifests.
#
# Usage:
#   ./scripts/install-ingress.sh                              (prompts)
#   ./scripts/install-ingress.sh --email admin@example.org
#   ./scripts/install-ingress.sh --email=admin@example.org
#   ./scripts/install-ingress.sh admin@example.org            (positional)
#
# Requirements:
#   - kubectl (configured to target your cluster)
#   - helm 3+
#   - A domain with DNS A/CNAME pointing to the cluster's
#     load balancer IP (or set up after first run)
# ============================================================

set -euo pipefail
cd "$(dirname "$0")/.."

# The documented form is `--email <address>`; the flag used to be swallowed as
# the address itself, so the documented invocation always failed validation with
# "Invalid email address: --email". Accept the flag, the =form, and a bare
# positional address, and reject anything else instead of silently using it.
EMAIL=""
case "${1:-}" in
    "")            ;;
    --email)       EMAIL="${2:-}" ;;
    --email=*)     EMAIL="${1#--email=}" ;;
    -h|--help)
        sed -n '2,17p' "$0"
        exit 0
        ;;
    -*)
        echo "[install-ingress] ERROR: unknown option: $1 (see --help)" >&2
        exit 1
        ;;
    *)             EMAIL="$1" ;;
esac

if [[ -z "$EMAIL" ]]; then
    read -rp "Enter your email for Let's Encrypt notifications: " EMAIL
fi

# Validate email before it is interpolated into YAML
if [[ ! "$EMAIL" =~ ^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$ ]]; then
    echo "[install-ingress] ERROR: Invalid email address: ${EMAIL}" >&2
    exit 1
fi

# Last verified: 2026-03-05 — check for newer releases before running in production
INGRESS_VERSION="4.12.2"
CERTMANAGER_VERSION="v1.17.1"

info() { echo "[install-ingress] $*"; }

# ── nginx-ingress ────────────────────────────────────────────
info "Adding Helm repos..."
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo add jetstack      https://charts.jetstack.io
helm repo update

info "Installing nginx-ingress-controller (v${INGRESS_VERSION})..."
helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
    --namespace ingress-nginx \
    --create-namespace \
    --version "${INGRESS_VERSION}" \
    --set controller.service.type=LoadBalancer \
    --set controller.config.use-forwarded-headers="true" \
    --set controller.config.proxy-body-size="16g" \
    --set controller.config.proxy-read-timeout="3600" \
    --wait

# ── cert-manager ─────────────────────────────────────────────
info "Installing cert-manager (${CERTMANAGER_VERSION})..."
helm upgrade --install cert-manager jetstack/cert-manager \
    --namespace cert-manager \
    --create-namespace \
    --version "${CERTMANAGER_VERSION}" \
    --set installCRDs=true \
    --wait

# ── ClusterIssuers ───────────────────────────────────────────
info "Creating Let's Encrypt ClusterIssuers..."
kubectl apply -f - <<EOF
---
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-staging
spec:
  acme:
    server: https://acme-staging-v02.api.letsencrypt.org/directory
    email: ${EMAIL}
    privateKeySecretRef:
      name: letsencrypt-staging-key
    solvers:
      - http01:
          ingress:
            class: nginx
---
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: ${EMAIL}
    privateKeySecretRef:
      name: letsencrypt-prod-key
    solvers:
      - http01:
          ingress:
            class: nginx
---
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: selfsigned-issuer
spec:
  selfSigned: {}
EOF

# ── Print load balancer IP ────────────────────────────────────
info "Waiting for LoadBalancer IP..."
sleep 10
LB_IP=$(kubectl get svc -n ingress-nginx ingress-nginx-controller \
    -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null \
    || kubectl get svc -n ingress-nginx ingress-nginx-controller \
       -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null \
    || echo "(pending)")

echo ""
echo "════════════════════════════════════════════════════"
echo "  nginx-ingress + cert-manager installed!"
echo "════════════════════════════════════════════════════"
echo "  Load Balancer endpoint: ${LB_IP}"
echo ""
echo "  Next steps:"
echo "  1. Point your DNS record for your domain → ${LB_IP}"
echo "  2. Run: kubectl apply -k k8s/overlays/production/"
echo "     (or gke / eks / aks overlay for your provider)"
echo ""
