# docker/vector/Dockerfile
# Builds the ipcrypt2 reference library (draft-denis-ipcrypt, ISC licence)
# from source plus a thin CLI wrapper, baked into the Vector image.
# NOTE: upstream ipcrypt-std/ipcrypt2 ships ONLY the static library
# (libipcrypt2.a) — it has no `ipcrypt` CLI. ipcrypt-cli.c provides one
# (`ipcrypt nd-encrypt`), which process-logs.sh uses to pseudonymise IPs.
FROM debian:bookworm-slim AS ipcrypt-build
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch 1.1.12 https://github.com/ipcrypt-std/ipcrypt2 /src/ipcrypt2 \
    && make -C /src/ipcrypt2
COPY ipcrypt-cli.c /src/ipcrypt-cli.c
RUN cc -O2 -Wall -I /src/ipcrypt2/src/include /src/ipcrypt-cli.c \
       /src/ipcrypt2/libipcrypt2.a -o /usr/local/bin/ipcrypt

FROM timberio/vector:0.57.0-debian
# logrotate drives the rotation loop in entrypoint.sh (raw access.log +
# appended security.log). Installed in the final image so the COPYed
# /etc/logrotate.d/vector-logs config is actually executable.
# jq is the JSON filter process-logs.sh uses to read .RequestPath/.ClientHost
# and to emit the pseudonymised line. The base timberio/vector image does NOT
# ship it; without it every jq call fails, each one is swallowed by its
# `|| continue`, and the pseudonymisation pipeline silently drops 100% of lines
# (security.log is never even created). It is load-bearing, not a convenience.
RUN apt-get update && apt-get install -y --no-install-recommends \
    logrotate jq \
    && rm -rf /var/lib/apt/lists/*
COPY --from=ipcrypt-build /usr/local/bin/ipcrypt /usr/local/bin/ipcrypt
# libipcrypt2.a is STATICALLY linked into that binary, so this image
# redistributes ISC-licensed code and the ISC notice has to travel with it.
# Taken from the pinned source tree rather than transcribed, so it cannot drift
# from the version actually linked. (The build stage is discarded; without this
# line the upstream notice went with it.)
COPY --from=ipcrypt-build /src/ipcrypt2/LICENSE /usr/share/doc/ipcrypt2/LICENSE
COPY process-logs.sh /usr/local/bin/process-logs.sh
COPY vector.toml /etc/vector/vector.toml
COPY logrotate.conf /etc/logrotate.d/vector-logs
# logrotate warns and (in stricter modes) skips configs that aren't 0644-owned;
# the COPY lands it 0755, so normalise the mode.
RUN chmod 0644 /etc/logrotate.d/vector-logs
RUN chmod +x /usr/local/bin/process-logs.sh
# Override entrypoint to start both process-logs.sh and Vector
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
