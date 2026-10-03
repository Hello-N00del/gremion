# test/host/fixtures/observability/collector.Dockerfile -- TASK-039 proof only.
#
# The host collector (infra/host/ops/metrics-textfile.sh) runs on the HOST in
# production. On a workstation whose Docker engine lives in a VM (Docker
# Desktop), the proof runs it in this container instead: the Docker CLI against
# the engine's socket, bash, jq and GNU coreutils (df --output, du -sb, date -d)
# -- the host's own toolset -- and a real 100 MiB tmpfs as GREMION_DISK_ROOT.
# Built by test/host/integration/observability-proof.sh; never shipped.
FROM docker:29-cli@sha256:b1805116a6a86cc591b5d5f60a910a0715cdcc9d18d866ad68b1457ead25c35c
RUN apk add --no-cache bash jq coreutils findutils
