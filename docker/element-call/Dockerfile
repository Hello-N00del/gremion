# Element Call for the pilot's video calls (service `element-call`, image
# gremion-element-call): the official web app, unchanged, pinned by digest.
#
# Why a one-line Dockerfile and not the upstream reference in the compose file: the
# image-digest lint (scripts/release/check-image-digests.mjs) refuses every image
# reference under the ghcr.io registry that is not our own namespace, so the pinned
# upstream image is the BASE here and the service the compose file names is built
# from it, like the other first-party images. Nothing is added: the config is NOT
# baked in. gremion-render renders docker/element-call/config.json from
# config.json.tmpl on the host (it names the platform domain and the pilot tenant
# host) and docker-compose.yml binds it at /app/config.json and /app/room/config.json.
#
# To re-pin after an intentional bump:
#   docker buildx imagetools inspect ghcr.io/element-hq/element-call:<tag> --format '{{.Manifest.Digest}}'
FROM ghcr.io/element-hq/element-call@sha256:c61fc9e4e04f75690c693d4556d01c09a2b9246f3fc8d35222d3aac36ba29906
