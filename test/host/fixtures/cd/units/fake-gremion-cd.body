#!/usr/bin/env bash
# The installed bin/gremion-cd of the cd-apply-root.bats fixture: it records its call and answers
# the way $GREMION_ROOT/.selftest-rc says (0 when the file is absent).
printf 'gremion-cd %s\n' "$*" >> "${SHIM_LOG}"
if [ -f "${GREMION_ROOT}/.selftest-rc" ]; then
    exit "$(cat "${GREMION_ROOT}/.selftest-rc")"
fi
exit 0
