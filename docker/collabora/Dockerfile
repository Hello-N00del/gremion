# Collabora Online CODE for the pilot's office editing (service `collabora`, image
# gremion-collabora). The official image, pinned by digest: the tag names the
# release, the digest is what runs. To re-pin after an intentional bump:
#   docker buildx imagetools inspect collabora/code:<tag> --format '{{.Manifest.Digest}}'
#
# The 26.04 line is a shell-less image on Debian 13: no shell, no apt, no curl, and
# it runs as uid 1001 (so this file sets no USER). Nothing can be installed or
# patched in a RUN layer, and nothing needs to be: it carries no libbrotli at all.
# The Brotli decoder out-of-bounds write (CVE-2026-111497) lived in the Debian 12
# libbrotli1 of the 24.04 line, which the previous version of this file upgraded as
# a stopgap. In 26.04 the package list (the SBOM under /usr/share/sbom) has no
# brotli or curl package, no libbrotli shared object exists in the image, and the
# DT_NEEDED entries of coolwsd and of the bundled libcurl name neither: there is no
# Brotli decoder to reach. Re-check that on every bump.
#
# The compose file's healthcheck is the exec-form `/usr/bin/coolwsd --probe
# --use-env-vars` (no shell, no curl); see docker-compose.yml.
FROM collabora/code:26.04.6.1.1@sha256:95f29f1c0a1778999125f53f058d968fe0afb37c95e32ebfb9f3444140faebd2
