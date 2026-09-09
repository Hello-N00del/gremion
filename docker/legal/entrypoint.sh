#!/bin/sh
# Gremion — Legal service entrypoint.
#
# Two-pass envsubst rendering strategy:
#   Pass 1: render _footer.html with all legal.env vars → capture as $FOOTER
#   Pass 2: for each page —
#           (a) envsubst "\$FOOTER"  → inject rendered footer (restricted — avoids
#               mangling CSS custom properties or other $-prefixed page content)
#           (b) envsubst            → substitute remaining legal.env vars in page body
#
# Variables sourced from environment:
#   Docker Compose: env_file: legal/legal.env
#   Kubernetes:     envFrom: secretRef: legal-config
#
# Output: clean-URL files (no .html extension) in /usr/share/nginx/html/
set -e

OUTPUT_DIR=/usr/share/nginx/html

# Pass 1: render footer (all vars substituted)
FOOTER=$(envsubst < /templates/_footer.html)
export FOOTER

# Pass 2: render each page template; skip partials (prefix _)
for tmpl in /templates/*.html; do
    name=$(basename "$tmpl")
    case "$name" in
        _*) continue ;;
    esac

    outname="${name%.html}"

    # (a) inject footer at ${FOOTER} only — restricted substitution
    # (b) substitute remaining vars (ORG_NAME, DOMAIN, etc.)
    envsubst "\$FOOTER" < "$tmpl" | envsubst > "${OUTPUT_DIR}/${outname}"
done

exec nginx -g 'daemon off;'
