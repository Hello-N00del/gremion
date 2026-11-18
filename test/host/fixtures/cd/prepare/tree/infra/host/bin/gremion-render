#!/usr/bin/env bash
# Fixture for cd-prepare.bats: stands in for the release tree's gremion-render. It records
# its call, and writes what the real one writes: an ignored output file and the host's
# ipcrypt key. $DK/render.mode: fail (exit 1 with text on both streams) or dirty (also
# leaves an untracked file that is not ignored).
printf 'gremion-render %s root=%s\n' "$*" "${GREMION_ROOT:-}" >>"$DK/render.log"
mode="$(cat "$DK/render.mode" 2>/dev/null || echo ok)"
if [ "$mode" = fail ]; then
    echo "RENDER-STDOUT-MARKER"
    echo "RENDER-STDERR-MARKER" >&2
    exit 1
fi
rel=""
while [ $# -gt 0 ]; do
    if [ "$1" = --release ]; then rel="$2"; shift; fi
    shift
done
echo rendered >"$rel/rendered.out"
mkdir -p "$GREMION_ROOT/etc/secrets"
if [ ! -f "$GREMION_ROOT/etc/secrets/ipcrypt_key.txt" ]; then
    echo 0123456789abcdef0123456789abcdef >"$GREMION_ROOT/etc/secrets/ipcrypt_key.txt"
fi
if [ "$mode" = dirty ]; then echo stray >"$rel/stray.txt"; fi
exit 0
