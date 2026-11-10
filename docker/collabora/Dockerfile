# Collabora Online CODE for the pilot's office editing (service `collabora`, image
# gremion-collabora), with the Debian Brotli fix.
#
# The 24.04 line ships Debian 12 libbrotli1 1.0.9-2+b6, which carries the Brotli
# decoder out-of-bounds write (CVE-2026-111497). Collabora reaches out over HTTP
# (WOPI and linked document resources) through curl, which decodes
# Content-Encoding: br. This image upgrades only that library. It is a STOPGAP: the
# 24.04 line has had no release since April 2025, and moving to 26.04 (a shell-less
# image) is its own smoke-tested upgrade.
#
# Pinned by digest: the tag names the release, the digest is what runs. To re-pin
# after an intentional bump:
#   docker buildx imagetools inspect collabora/code:<tag> --format '{{.Manifest.Digest}}'
FROM collabora/code:24.04.10.1.1@sha256:98bfe4bbd18d5faa77f7e3dc0b87309a8d0252c1f4fc81a7f1d9f7a58d4b6ce8
USER root
RUN apt-get update -qq \
 && apt-get install -y -qq --only-upgrade libbrotli1 \
 && rm -rf /var/lib/apt/lists/* \
 && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' libbrotli1)" ge 1.0.9-2+deb12u1
USER 100
