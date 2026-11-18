#!/usr/bin/env bash
# infra/host/lib/cd/classify.sh -- the release classifier of gremion-cd (unit cd-classify).
#
# SOURCED, NEVER EXECUTED (see core.sh): no shell options set at the top level, nothing
# runs there except assignments. It calls cd_dc of docker.sh (resolved at call time) and
# git, jq, sha256sum and coreutils.
#
#   cd_classify OLD_TREE NEW_TREE [--manifest FILE] [--no-compose]
#   gremion-cd classify FROM TO [--no-compose]        (read-only replay over a range)
#
# cd_classify is a pure function of two release trees (a clean git work tree each: the
# LIVE tree and the CANDIDATE tree) and of the host manifest. It prints ONE line of JSON
# and returns 0 for every verdict, including "held" and "classify_failed" (a hold is an
# answer, not a failure of the function). It returns 2 only for a bad argument. An error
# inside the classifier is never a default: it becomes a `classify_failed` hold with a
# code, so unknown is never green.
#
# THE DOCUMENT (jq -cS, byte-identical for the same two trees)
#   v            1
#   app_only     true when state_tier is empty AND classification did not fail (an unknown
#                state tier is not an empty one). Other holds leave it true: whether the
#                state stages are needed is a question about state_tier only, and every
#                hold, whatever app_only says, is in `holds`
#   state_tier   reason codes of the state tier: compose_state:<service>, edge,
#                host_programs, shared_sql, platform_migration (sorted, unique)
#   holds        every hold as {kind, reason}, most restrictive first, then by reason.
#                Holds accumulate and never replace each other: a caller must look at
#                ALL of them, not at the first one (`hold` is only that first one)
#   hold         holds[0] or null
#   compose      "checked" or "skipped" (the replay verb's --no-compose)
#   migrations   {total, chains: {<chain>: {class, expand, migrate, contract}}}: new files
#                of the migration lock, counted per chain and phase, with the LIVE class
#   host         {changed, groups: {bin, lib, lib_cd, bootstrap, systemd, nftables, env}}
#                counts of manifest-set files that differ from the host manifest
#   ci_changed   whether the range changes anything under .github/workflows
# Names and counts only: no hash, no path, no value of the rendered compose config
# (which resolves secrets) ever reaches the output, a log or an argv.
#
# HOLD KINDS it produces: state_tier, unsupported_chain, contract_migration,
# waived_migration, ci_changed, chain_class_changed, classify_failed. The kinds that
# come from the poll (batch_too_large, not_ancestor, ruleset_missing, range_unverified)
# are not decided here.
#
# STATE TIER (decided by effect, not by a path list): compose_state (the rendered compose
# config of the state project, with the tree prefix stripped, plus the git entry of every
# bind-mount source, config file and build context inside the tree), edge, host_programs
# (a file of the manifest set differs from the MANIFEST, not from the old tree),
# shared_sql, platform_migration.
#
# THE MANIFEST SET (repo-relative; infra/host/lib is the whole tree, cd/ included):
#   infra/host/bin/*  infra/host/lib/**  infra/host/bootstrap.sh
#   infra/host/templates/{systemd,nftables,env}/*
# The manifest is data/cd/host-manifest.json: {"v":1,"files":{"<relpath>":"<sha256>"}}.
#
# TREES ARE READ FROM GIT (HEAD of a clean work tree). Hashes of directories, build
# contexts and bind sources are git entries (mode, type, object id), so a file that is
# untracked, or that a later stage renders into the tree, never makes a tree "differ". A
# tree that is not a git work tree, or has a tracked change, is `classify_failed`.
#
# MIGRATIONS. The verdict for a new file comes from the class of its chain in the LIVE
# tree's chain-runners.json, through an allow-list of chain and class pairs; the
# NEW tree's file must agree (a different class is chain_class_changed, in addition).
#
# shellcheck disable=SC2016  # the jq programs are single-quoted on purpose

CD_CLS_HOLD_ORDER='["classify_failed","contract_migration","waived_migration","unsupported_chain","chain_class_changed","ci_changed","state_tier"]'

_cd_cls_err() { printf 'cd-classify: %s\n' "$*" >&2; }

# _cd_cls_git TREE ARGS... -- git on a work tree, never reading the caller's GIT_* variables.
_cd_cls_git() {
    local tree="$1"
    shift
    env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_NAMESPACE \
        git -C "$tree" --no-optional-locks "$@" </dev/null
}

# _cd_cls_entry TREE REL -- the git entry ("<mode> <type> <oid>") of a path at HEAD, or the
# word `absent`. REL is "." for the whole tree. Returns 1 when git cannot answer.
_cd_cls_entry() {
    local tree="$1" rel="$2" line
    if [[ "$rel" == . ]]; then
        line="$(_cd_cls_git "$tree" rev-parse 'HEAD^{tree}')" || return 1
        printf '040000 tree %s\n' "$line"
        return 0
    fi
    rel="${rel%/}"
    line="$(_cd_cls_git "$tree" ls-tree HEAD -- "$rel")" || return 1
    if [[ -z "$line" ]]; then
        printf 'absent\n'
        return 0
    fi
    line="${line%%$'\t'*}"
    printf '%s\n' "$line"
}

# _cd_cls_changed OLD NEW REL... -- 0 when any of the paths differs between the two trees,
# 1 when none does, 2 when git cannot answer.
_cd_cls_changed() {
    local old="$1" new="$2" rel a b differs=1
    shift 2
    for rel in "$@"; do
        a="$(_cd_cls_entry "$old" "$rel")" || return 2
        b="$(_cd_cls_entry "$new" "$rel")" || return 2
        [[ "$a" == "$b" ]] || differs=0
    done
    return "$differs"
}

# _cd_cls_tree_ok TREE -- a clean git work tree whose top level is TREE itself.
_cd_cls_tree_ok() {
    local tree="$1" top real dirty
    [[ -d "$tree" ]] || return 1
    real="$(cd "$tree" && pwd -P)" || return 1
    top="$(_cd_cls_git "$tree" rev-parse --show-toplevel)" || return 1
    [[ "$(cd "$top" && pwd -P)" == "$real" ]] || return 1
    _cd_cls_git "$tree" rev-parse --verify -q 'HEAD^{commit}' >/dev/null || return 1
    dirty="$(_cd_cls_git "$tree" status --porcelain --untracked-files=no)" || return 1
    [[ -z "$dirty" ]]
}

# _cd_cls_jq_ok FILTER FILE -- 0 when FILE holds exactly one JSON value for which FILTER is
# true. Not `jq -e` alone: jq 1.6 answers 0 for -e on an EMPTY file, which would read an
# emptied file as a valid one.
_cd_cls_jq_ok() {
    jq -e -s "length == 1 and (.[0] | ${1})" "$2" >/dev/null 2>&1
}

# _cd_cls_json TREE REL -- 0 when TREE/REL is a regular file of one JSON document.
_cd_cls_json() {
    local f="$1/$2"
    [[ -f "$f" && -r "$f" ]] || return 1
    _cd_cls_jq_ok true "$f"
}

# _cd_cls_host_files TREE -- JSON object {relpath: sha256} of the manifest set of a tree.
_cd_cls_host_files() {
    local tree="$1" out rc=0
    out="$(
        _cd_cls_git "$tree" ls-files -z -- \
            ':(glob)infra/host/bin/*' ':(glob)infra/host/lib/**' infra/host/bootstrap.sh \
            ':(glob)infra/host/templates/systemd/*' ':(glob)infra/host/templates/nftables/*' \
            ':(glob)infra/host/templates/env/*' \
            | (cd "$tree" && xargs -0 -r sha256sum -- ) \
            | jq -R -s -c '
                split("\n") | map(select(length > 0))
                | map(capture("^(?<h>[0-9a-f]{64}) [ *](?<p>[^\\\\]+)$"))
                | map({key: .p, value: .h}) | from_entries'
    )" || rc=$?
    [[ "$rc" -eq 0 && -n "$out" ]] || return 1
    printf '%s\n' "$out"
}

# _cd_cls_compose TREE OUTFILE TMPDIR -- the normalised compose view of the state project:
# {top, services: {<name>: {def, paths: {<relpath-in-tree>: <git entry>}}}}, written to
# OUTFILE. The rendered config resolves secrets, so it lives only in files of the 0700
# TMPDIR and reaches jq as a file, never as an argument.
_cd_cls_compose() {
    local tree="$1" out="$2" tmp="$3" raw="$3/raw.json" norm="$3/norm.json"
    local phys rel entry
    local -a prefixes=()
    phys="$(cd "$tree" && pwd -P)" || return 1
    prefixes+=("$(cd "$tree" && pwd)" "$phys")
    # the one compose shape of docker.sh; stdout goes to the file, never to a stream
    if ! CD_DC_TIMEOUT="${CD_DC_TIMEOUT:-60}" cd_dc "$tree" state config --format json >"$raw" 2>/dev/null; then
        return 1
    fi
    _cd_cls_jq_ok '(.services | type) == "object"' "$raw" || return 1
    # strip the tree prefix (longest first, at path boundaries) so a release tree's
    # location is not a difference
    printf '%s\n' "${prefixes[@]}" | LC_ALL=C sort -u | awk '{ print length($0) "\t" $0 }' \
        | LC_ALL=C sort -rn | cut -f2- >"$tmp/prefixes.txt"
    jq -S --rawfile ps "$tmp/prefixes.txt" '
        def esc: gsub("(?<c>[\\\\.^$*+?()\\[\\]{}|])"; "\\\(.c)");
        ($ps | split("\n") | map(select(length > 0))) as $list
        | walk(if type == "string" then
                 reduce $list[] as $p (.; gsub("(?<![A-Za-z0-9_./-])" + ($p | esc) + "(?![A-Za-z0-9_.-])"; "@TREE@"))
               else . end)' "$raw" >"$norm" || return 1
    # the paths inside the tree that a service reads: bind sources, configs, build context
    jq -r '
        . as $root
        | ($root.services // {}) | to_entries[] | .value as $s
        | ( (($s.volumes // [])[] | select(type == "object" and .type == "bind") | .source),
            ($s.build | if type == "object" then .context elif type == "string" then . else empty end),
            (($s.configs // [])[] | (if type == "string" then . else .source end) as $n | ($root.configs[$n].file? // empty)) )
        | select(type == "string" and startswith("@TREE@"))
        | ltrimstr("@TREE@") | ltrimstr("/") | if . == "" then "." else . end' "$norm" \
        | LC_ALL=C sort -u >"$tmp/rels.txt" || return 1
    : >"$tmp/paths.tsv"
    while IFS= read -r rel; do
        [[ -n "$rel" ]] || continue
        [[ "$rel" != *[[:cntrl:]]* ]] || return 1
        entry="$(_cd_cls_entry "$tree" "$rel")" || return 1
        printf '%s\t%s\n' "$rel" "$entry" >>"$tmp/paths.tsv"
    done <"$tmp/rels.txt"
    jq -R -s -c 'split("\n") | map(select(length > 0) | split("\t") | {key: .[0], value: .[1]}) | from_entries' \
        "$tmp/paths.tsv" >"$tmp/paths.json" || return 1
    jq -S -c --slurpfile p "$tmp/paths.json" '
        . as $root | $p[0] as $p
        | def reads($s):
            [ (($s.volumes // [])[] | select(type == "object" and .type == "bind") | .source),
              ($s.build | if type == "object" then .context elif type == "string" then . else empty end),
              (($s.configs // [])[] | (if type == "string" then . else .source end) as $n | ($root.configs[$n].file? // empty)) ]
            | map(select(type == "string" and startswith("@TREE@")) | ltrimstr("@TREE@") | ltrimstr("/") | if . == "" then "." else . end)
            | unique | map({key: ., value: ($p[.] // "absent")}) | from_entries;
        { top: ($root | del(.services)),
          services: (($root.services // {}) | with_entries(.value as $s | .value = {def: $s, paths: reads($s)})) }' \
        "$norm" >"$out" || return 1
    return 0
}

# _cd_cls_body OLD NEW TMP MANIFEST SKIP_COMPOSE -- runs every check and prints the
# document. It runs in a subshell of cd_classify and checks every step itself.
_cd_cls_body() {
    local old="$1" new="$2" tmp="$3" manifest="$4" skip_compose="$5"
    local compose="checked" ci_changed=false
    local a b kind chain file cls mod hdr first phase ok n
    local -A old_class=() new_class=() chain_count=() chain_phase=()
    set +e
    _CLS_TMP="$tmp"
    : >"$tmp/e.txt"
    : >"$tmp/h.txt"
    : >"$tmp/s.txt"
    : >"$tmp/newfiles.tsv"

    local side tree
    for side in old new; do
        tree="$old"
        [[ "$side" == new ]] && tree="$new"
        if ! _cd_cls_tree_ok "$tree"; then
            _cls_err "tree_unreadable:${side}"
        fi
    done
    if [[ -s "$tmp/e.txt" ]]; then
        _cd_cls_emit "$tmp" "$compose" "$ci_changed" '{"changed":0,"groups":{}}' "$tmp/none.tsv"
        return 0
    fi

    # -- migrations ---------------------------------------------------------------
    local lockok=1 f
    for f in scripts/migrations/applied.lock.json scripts/migrations/ranges.json \
        scripts/migrations/runner/chain-runners.json scripts/migrations/runner/lint-waivers.json; do
        for side in old new; do
            tree="$old"
            [[ "$side" == new ]] && tree="$new"
            if ! _cd_cls_json "$tree" "$f"; then
                _cls_err "unreadable:${f##*/}:${side}"
                lockok=0
            fi
        done
    done
    local mig_lines="$tmp/mig.tsv"
    : >"$mig_lines"
    if ((lockok)); then
        for side in old new; do
            tree="$old"
            [[ "$side" == new ]] && tree="$new"
            _cd_cls_jq_ok '(.chains | type) == "object" and ([.chains[] | (.files | type) == "object"] | all)' \
                "$tree/scripts/migrations/applied.lock.json" || { _cls_err "lock_shape:${side}"; lockok=0; }
            _cd_cls_jq_ok '(.chains | type) == "array" and ([.chains[] | (.id | type) == "string"] | all)' \
                "$tree/scripts/migrations/ranges.json" || { _cls_err "ranges_shape:${side}"; lockok=0; }
            _cd_cls_jq_ok '(.chains | type) == "object" and ([.chains[] | type == "string"] | all)' \
                "$tree/scripts/migrations/runner/chain-runners.json" || { _cls_err "runners_shape:${side}"; lockok=0; }
            _cd_cls_jq_ok '(.waivers | type) == "array"' \
                "$tree/scripts/migrations/runner/lint-waivers.json" || { _cls_err "waivers_shape:${side}"; lockok=0; }
        done
    fi
    if ((lockok)); then
        # new, changed and removed entries of the lock
        jq -r -n --slurpfile o "$old/scripts/migrations/applied.lock.json" --slurpfile n "$new/scripts/migrations/applied.lock.json" '
            ($o[0].chains) as $oc | ($n[0].chains) as $nc
            | ( $nc | to_entries[] | .key as $c | (.value.files | to_entries[])
                | . as $e | ($oc[$c].files // {})[$e.key] as $was
                | if $was == null then "new\t\($c)\t\($e.key)"
                  elif $was != $e.value then "changed\t\($c)\t\($e.key)" else empty end ),
              ( $oc | to_entries[] | .key as $c | (.value.files | to_entries[])
                | select(($nc[$c].files // {})[.key] == null) | "removed\t\($c)\t\(.key)" )' >"$mig_lines" \
            || { _cls_err "lock_diff"; lockok=0; }
    fi
    if ((lockok)); then
        while IFS=$'\t' read -r kind chain file; do
            [[ -n "$kind" ]] || continue
            if [[ ! "$chain" =~ ^[a-z0-9][a-z0-9-]*$ || ! "$file" =~ ^[A-Za-z0-9._-]+$ ]]; then
                _cls_err "lock_name_invalid"
                continue
            fi
            case "$kind" in
                changed) _cls_err "locked_file_changed:${chain}" ;;
                removed) _cls_err "locked_file_removed:${chain}" ;;
                new)
                    # the file, in exactly one directory of the chain (ranges.json of the NEW tree)
                    n=0
                    hdr=''
                    while IFS= read -r a; do
                        [[ -n "$a" ]] || continue
                        if [[ -f "$new/$a/$file" ]]; then
                            n=$((n + 1))
                            hdr="$new/$a/$file"
                        fi
                    done < <(jq -r --arg c "$chain" '.chains[] | select(.id == $c) | (.dirs // [])[]' "$new/scripts/migrations/ranges.json")
                    if ((n != 1)); then
                        _cls_err "file_not_located:${chain}"
                        continue
                    fi
                    first=''
                    IFS= read -r first <"$hdr" || true
                    first="${first#$'\xEF\xBB\xBF'}"
                    first="${first%$'\r'}"
                    if [[ "$first" =~ ^--\ gremion:phase\ (expand|migrate|contract)[[:space:]]*$ ]]; then
                        phase="${BASH_REMATCH[1]}"
                    else
                        _cls_err "phase_header:${chain}"
                        continue
                    fi
                    printf '%s\t%s\n' "$chain" "$phase" >>"$tmp/newfiles.tsv"
                    ;;
            esac
        done <"$mig_lines"
    fi
    if ((lockok)); then
        while IFS=$'\t' read -r chain cls; do
            [[ -n "$chain" ]] || continue
            old_class["$chain"]="$cls"
        done < <(jq -r '.chains | to_entries[] | "\(.key)\t\(.value)"' "$old/scripts/migrations/runner/chain-runners.json")
        while IFS=$'\t' read -r chain cls; do
            [[ -n "$chain" ]] || continue
            new_class["$chain"]="$cls"
        done < <(jq -r '.chains | to_entries[] | "\(.key)\t\(.value)"' "$new/scripts/migrations/runner/chain-runners.json")
        # a chain the live file has must stay in the new file; a chain only the new file has
        # and every class that differs is chain_class_changed
        for chain in "${!old_class[@]}"; do
            if [[ -z "${new_class[$chain]+set}" ]]; then
                _cls_err "chain_missing:${chain}"
            elif [[ "${old_class[$chain]}" != "${new_class[$chain]}" ]]; then
                if ! _cd_cls_known_class "${old_class[$chain]}" || ! _cd_cls_known_class "${new_class[$chain]}"; then
                    _cls_err "class_unknown:${chain}"
                fi
                _cls_hold chain_class_changed "chain_class_changed:${chain}"
            fi
        done
        for chain in "${!new_class[@]}"; do
            if [[ -z "${old_class[$chain]+set}" ]]; then
                _cd_cls_known_class "${new_class[$chain]}" || _cls_err "class_unknown:${chain}"
                _cls_hold chain_class_changed "chain_class_changed:${chain}"
            fi
        done
        # the new files, judged by the LIVE class
        while IFS=$'\t' read -r chain phase; do
            [[ -n "$chain" ]] || continue
            chain_count["$chain"]=$((${chain_count[$chain]:-0} + 1))
            chain_phase["${chain}:${phase}"]=$((${chain_phase[${chain}:${phase}]:-0} + 1))
            [[ "$phase" == contract ]] && _cls_hold contract_migration "contract_migration:${chain}"
        done <"$tmp/newfiles.tsv"
        for chain in "${!chain_count[@]}"; do
            [[ "$chain" == platform ]] && _cls_state platform_migration
            if [[ -z "${old_class[$chain]+set}" ]]; then
                continue # only the new file has the chain: chain_class_changed above
            fi
            cls="${old_class[$chain]}"
            case "$cls:$chain" in
                unadopted:*) _cls_hold unsupported_chain "chain_unadopted:${chain}" ;;
                fresh-only:*) _cls_hold unsupported_chain "chain_fresh_only:${chain}" ;;
                legacy-boot:control | legacy-boot:kernel-data | tenant-store:kernel-api | tenant-store:platform) ;;
                module-upgrade:module-*) ;;
                *)
                    if _cd_cls_known_class "$cls"; then
                        _cls_err "chain_class_pair:${chain}"
                    else
                        _cls_err "class_unknown:${chain}"
                    fi
                    ;;
            esac
        done
        # a lint waiver that the new tree has and the live tree does not
        n="$(jq -n -r --slurpfile o "$old/scripts/migrations/runner/lint-waivers.json" --slurpfile w "$new/scripts/migrations/runner/lint-waivers.json" '
            ($o[0].waivers | map({chain, file, sha256})) as $was
            | [$w[0].waivers[] | {chain, file, sha256} | select(. as $x | $was | index($x) | not)] | length')" \
            || { _cls_err "waivers_diff"; n=0; }
        [[ "$n" =~ ^[0-9]+$ ]] || n=0
        ((n > 0)) && _cls_hold waived_migration "waived_migration"
    fi

    # -- module declarations --------------------------------------------------------
    local -A mods=()
    for tree in "$old" "$new"; do
        for f in "$tree"/modules/*/module.json; do
            [[ -f "$f" ]] || continue
            mod="${f%/module.json}"
            mod="${mod##*/}"
            if [[ ! "$mod" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
                _cls_err "module_name_invalid"
                continue
            fi
            mods["$mod"]=1
        done
    done
    for mod in "${!mods[@]}"; do
        a=null
        b=null
        ok=1
        if [[ -f "$old/modules/$mod/module.json" ]]; then
            a="$(jq -cS '.runtime.database // null' "$old/modules/$mod/module.json" 2>/dev/null)" || ok=0
        fi
        if [[ -f "$new/modules/$mod/module.json" ]]; then
            b="$(jq -cS '.runtime.database // null' "$new/modules/$mod/module.json" 2>/dev/null)" || ok=0
        fi
        if ((ok == 0)) || [[ -z "$a" || -z "$b" ]]; then
            _cls_err "module_json_invalid"
            continue
        fi
        [[ "$a" == "$b" ]] || _cls_hold unsupported_chain "module_declaration_changed:${mod}"
    done

    # -- the pull request gate --------------------------------------------------------
    _cd_cls_changed "$old" "$new" .github/workflows
    case "$?" in
        0)
            ci_changed=true
            _cls_hold ci_changed ci_changed
            ;;
        1) ;;
        *) _cls_err "ci_entry" ;;
    esac

    # -- edge, shared sql -----------------------------------------------------------------
    _cd_cls_changed "$old" "$new" infra/host/templates/edge docker/traefik
    case "$?" in
        0) _cls_state edge ;;
        1) ;;
        *) _cls_err "edge_entry" ;;
    esac
    _cd_cls_changed "$old" "$new" docker/pgbouncer/pgbouncer-auth.sql
    case "$?" in
        0) _cls_state shared_sql ;;
        1) ;;
        *) _cls_err "sql_entry" ;;
    esac

    # -- host programs: the NEW tree against the manifest --------------------------------------
    local host_json='{"changed":0,"groups":{}}'
    if _cd_cls_jq_ok '.v == 1 and (.files | type) == "object" and ([.files[] | type == "string"] | all)' "$manifest"; then
        if _cd_cls_host_files "$new" >"$tmp/hostfiles.json"; then
            host_json="$(jq -c -n --slurpfile m "$manifest" --slurpfile f "$tmp/hostfiles.json" '
                def grp:
                  if startswith("infra/host/lib/cd/") then "lib_cd"
                  elif startswith("infra/host/lib/") then "lib"
                  elif startswith("infra/host/bin/") then "bin"
                  elif . == "infra/host/bootstrap.sh" then "bootstrap"
                  elif startswith("infra/host/templates/systemd/") then "systemd"
                  elif startswith("infra/host/templates/nftables/") then "nftables"
                  elif startswith("infra/host/templates/env/") then "env"
                  else "other" end;
                $m[0].files as $mf | $f[0] as $nf
                | [ (($mf | keys) + ($nf | keys)) | unique[] | select($mf[.] != $nf[.]) ] as $ch
                | {changed: ($ch | length), groups: ($ch | map(grp) | group_by(.) | map({key: .[0], value: length}) | from_entries)}')" \
                || { _cls_err "host_diff"; host_json='{"changed":0,"groups":{}}'; }
            n="$(jq -r '.changed' <<<"$host_json")"
            [[ "$n" =~ ^[0-9]+$ ]] && ((n > 0)) && _cls_state host_programs
        else
            _cls_err "host_files"
        fi
    else
        _cls_err "manifest_unreadable"
    fi

    # -- compose of the state project ---------------------------------------------------------------
    if [[ "$skip_compose" == 1 ]]; then
        compose=skipped
    else
        if _cd_cls_compose "$old" "$tmp/cmp.old.json" "$tmp" && _cd_cls_compose "$new" "$tmp/cmp.new.json" "$tmp"; then
            while IFS= read -r a; do
                [[ -n "$a" ]] || continue
                _cls_state "compose_state:${a}"
            done < <(jq -r -n --slurpfile o "$tmp/cmp.old.json" --slurpfile n "$tmp/cmp.new.json" '
                ($o[0].services) as $os | ($n[0].services) as $ns
                | ( (($os | keys) + ($ns | keys)) | unique[] | select($os[.] != $ns[.]) ),
                  (if $o[0].top != $n[0].top then "_project" else empty end)')
        else
            _cls_err "compose_render"
        fi
    fi

    # -- the migration counts, then the one document ------------------------------------------------
    : >"$tmp/counts.tsv"
    for chain in "${!chain_count[@]}"; do
        printf '%s\t%s\t%s\t%s\t%s\n' "$chain" "${old_class[$chain]:-}" "${chain_phase[${chain}:expand]:-0}" \
            "${chain_phase[${chain}:migrate]:-0}" "${chain_phase[${chain}:contract]:-0}" >>"$tmp/counts.tsv"
    done
    _cd_cls_emit "$tmp" "$compose" "$ci_changed" "$host_json" "$tmp/counts.tsv"
}

# the accumulators of one run: files of its temporary directory
_cls_err() { printf '%s\n' "$1" >>"${_CLS_TMP}/e.txt"; }
_cls_hold() { printf '%s\t%s\n' "$1" "$2" >>"${_CLS_TMP}/h.txt"; }
_cls_state() { printf '%s\n' "$1" >>"${_CLS_TMP}/s.txt"; _cls_hold state_tier "$1"; }

# _cd_cls_known_class CLASS -- the five classes of chain-runners.json.
_cd_cls_known_class() {
    case "$1" in
        tenant-store | legacy-boot | module-upgrade | unadopted | fresh-only) return 0 ;;
        *) return 1 ;;
    esac
}

# _cd_cls_emit TMP COMPOSE CI HOSTJSON COUNTSFILE -- prints the document from the
# accumulator files of TMP (e.txt errors, h.txt holds, s.txt state reasons).
_cd_cls_emit() {
    local tmp="$1" compose="$2" ci="$3" host_json="$4" counts="$5"
    [[ -f "$counts" ]] || { counts="$tmp/none.tsv"; : >"$counts"; }
    jq -n -c -S --argjson order "$CD_CLS_HOLD_ORDER" --arg compose "$compose" --argjson ci "$ci" \
        --argjson host "$host_json" \
        --rawfile e "$tmp/e.txt" --rawfile h "$tmp/h.txt" --rawfile s "$tmp/s.txt" --rawfile c "$counts" '
        def lines: split("\n") | map(select(length > 0));
        def code: gsub("[^A-Za-z0-9_:./+-]"; "_") | .[0:120];
        ( ($e | lines | unique | map({kind: "classify_failed", reason: ("classify_failed:" + code)}))
        + ($h | lines | map(split("\t") | {kind: .[0], reason: (.[1] | code)})) ) as $all
        | ($all | unique | sort_by([(. as $x | $order | index($x.kind)), .reason])) as $holds
        | ($s | lines | map(code) | unique) as $state
        | ($c | lines | map(split("\t") | {key: .[0], value: {class: (if .[1] == "" then null else .[1] end),
              expand: (.[2] | tonumber), migrate: (.[3] | tonumber), contract: (.[4] | tonumber)}}) | from_entries) as $chains
        | {v: 1,
           app_only: (($state | length) == 0 and ([$holds[] | select(.kind == "classify_failed")] | length) == 0),
           state_tier: $state,
           holds: $holds,
           hold: ($holds[0] // null),
           compose: $compose,
           migrations: {total: ($chains | to_entries | map(.value.expand + .value.migrate + .value.contract) | add // 0), chains: $chains},
           host: $host,
           ci_changed: $ci}'
}

# cd_classify OLD_TREE NEW_TREE [--manifest FILE] [--no-compose]
cd_classify() {
    local old="${1:-}" new="${2:-}" manifest='' skip=0 tmp doc rc=0 root
    [[ "$#" -ge 2 ]] || { _cd_cls_err "usage: cd_classify OLD_TREE NEW_TREE [--manifest FILE] [--no-compose]"; return 2; }
    shift 2
    while [[ "$#" -gt 0 ]]; do
        case "$1" in
            --manifest)
                [[ "$#" -ge 2 ]] || { _cd_cls_err "--manifest needs a file"; return 2; }
                manifest="$2"
                shift 2
                ;;
            --no-compose)
                skip=1
                shift
                ;;
            *)
                _cd_cls_err "unknown argument"
                return 2
                ;;
        esac
    done
    [[ -d "$old" && -d "$new" ]] || { _cd_cls_err "OLD_TREE and NEW_TREE must be directories"; return 2; }
    root="${GREMION_ROOT:-/opt/gremion}"
    [[ -n "$manifest" ]] || manifest="${root}/data/cd/host-manifest.json"
    tmp="$(umask 077 && mktemp -d "${TMPDIR:-/tmp}/cd-classify.XXXXXX")" || { _cd_cls_err "no temporary directory"; return 2; }
    # stderr of the body is dropped: a jq or compose error message can quote a value of the
    # rendered config, which resolves secrets
    doc="$(_cd_cls_body "$old" "$new" "$tmp" "$manifest" "$skip" 2>/dev/null)" || rc=$?
    if [[ "$rc" -ne 0 || -z "$doc" ]] || ! jq -e '.v == 1' <<<"$doc" >/dev/null 2>&1; then
        # the classifier itself broke: that is a verdict (fail closed), never an empty answer
        doc="$(jq -n -c -S '{v: 1, app_only: false, state_tier: [], holds: [{kind: "classify_failed", reason: "classify_failed:internal"}],
            hold: {kind: "classify_failed", reason: "classify_failed:internal"}, compose: "checked",
            migrations: {total: 0, chains: {}}, host: {changed: 0, groups: {}}, ci_changed: false}')"
    fi
    rm -rf -- "$tmp"
    printf '%s\n' "$doc"
    return 0
}

# -- the replay verb ---------------------------------------------------------------------------
# cd_cmd_classify FROM TO [--no-compose] -- read-only. Every first-parent commit of
# FROM..TO is classified against its predecessor, as if the host had been at the
# predecessor (the host manifest is the predecessor's own: what the program would hold
# for that one commit). Needs the mirror. Prints one line per pair and a count.
cd_cmd_classify() {
    local from="${1:-}" to="${2:-}" skip=0 a mirror work prev cur sha base pairs=0 auto=0 held=0 hostonly=0 hostlib=0
    local doc verdict reasons i max=200
    local -a shas=() extra=()
    local -A kinds=()
    [[ "$#" -ge 2 ]] || cd_die 2 "usage: gremion-cd classify FROM TO [--no-compose]"
    shift 2
    for a in "$@"; do
        case "$a" in
            --no-compose) skip=1; extra+=(--no-compose) ;;
            *) cd_die 2 "classify: unknown argument (usage: gremion-cd classify FROM TO [--no-compose])" ;;
        esac
    done
    mirror="$CD_MIRROR_DIR"
    [[ -d "$mirror" ]] || cd_die 2 "classify: the mirror does not exist (nothing has been fetched yet)"
    from="$(env -u GIT_DIR git --git-dir="$mirror" rev-parse --verify -q "${from}^{commit}" </dev/null)" \
        || cd_die 2 "classify: FROM is not a commit of the mirror"
    to="$(env -u GIT_DIR git --git-dir="$mirror" rev-parse --verify -q "${to}^{commit}" </dev/null)" \
        || cd_die 2 "classify: TO is not a commit of the mirror"
    env -u GIT_DIR git --git-dir="$mirror" merge-base --is-ancestor "$from" "$to" </dev/null \
        || cd_die 2 "classify: FROM is not an ancestor of TO"
    mapfile -t shas < <(env -u GIT_DIR git --git-dir="$mirror" rev-list --first-parent --reverse "${from}..${to}" </dev/null)
    ((${#shas[@]} <= max)) || cd_die 2 "classify: more than ${max} commits in the range"
    if ((${#shas[@]} == 0)); then
        cd_info "classified 0 pairs: automatic 0, held 0"
        return 0
    fi
    work="$(umask 077 && mktemp -d "${TMPDIR:-/tmp}/cd-classify-replay.XXXXXX")" || cd_die 2 "classify: no temporary directory"
    base="$work"
    for i in a b; do
        env -u GIT_DIR git clone -q --shared --no-checkout "$mirror" "$base/$i" </dev/null >/dev/null 2>&1 \
            || { rm -rf -- "$work"; cd_die 2 "classify: could not make a work tree from the mirror"; }
    done
    env -u GIT_DIR git -C "$base/a" -c advice.detachedHead=false checkout -q --detach "$from" </dev/null >/dev/null 2>&1 \
        || { rm -rf -- "$work"; cd_die 2 "classify: could not check out FROM"; }
    prev="$base/a"
    cur="$base/b"
    local prev_sha="$from" tmp_t
    for sha in "${shas[@]}"; do
        if ! env -u GIT_DIR git -C "$cur" -c advice.detachedHead=false checkout -q --detach "$sha" </dev/null >/dev/null 2>&1; then
            rm -rf -- "$work"
            cd_die 2 "classify: could not check out a commit of the range"
        fi
        if _cd_cls_host_files "$prev" >"$work/files.json"; then
            jq -c '{v: 1, files: .}' "$work/files.json" >"$work/manifest.json"
        else
            printf '{}\n' >"$work/manifest.json"
        fi
        doc="$(cd_classify "$prev" "$cur" --manifest "$work/manifest.json" ${extra[@]+"${extra[@]}"})"
        pairs=$((pairs + 1))
        reasons="$(jq -r '[.holds[] | .reason] | join(",")' <<<"$doc")"
        if [[ "$(jq -r "(.holds | length) == 0" <<<"$doc")" == true ]]; then
            verdict=automatic
            auto=$((auto + 1))
        else
            verdict=held
            held=$((held + 1))
            # held only by host_programs, and only through infra/host/lib/**
            if jq -e '(.holds | length) == 1 and .holds[0].reason == "host_programs"
                      and ([.host.groups | keys[] | select(. != "lib" and . != "lib_cd")] | length) == 0' <<<"$doc" >/dev/null; then
                hostonly=$((hostonly + 1))
                if jq -e "(.host.groups | keys | index(\"lib_cd\")) == null" <<<"$doc" >/dev/null; then
                    hostlib=$((hostlib + 1))
                fi
            fi
            while IFS= read -r a; do
                [[ -n "$a" ]] || continue
                kinds["$a"]=$((${kinds[$a]:-0} + 1))
            done < <(jq -r '[.holds[].kind] | unique[]' <<<"$doc")
        fi
        printf '%s..%s %s%s\n' "${prev_sha:0:12}" "${sha:0:12}" "$verdict" "${reasons:+ $reasons}"
        tmp_t="$prev"
        prev="$cur"
        cur="$tmp_t"
        prev_sha="$sha"
    done
    rm -rf -- "$work"
    cd_info "classified ${pairs} pairs: automatic ${auto}, held ${held}"
    for a in $(printf '%s\n' "${!kinds[@]}" | LC_ALL=C sort); do
        cd_info "held with ${a}: ${kinds[$a]}"
    done
    cd_info "held only by host_programs through infra/host/lib/** (lib and lib/cd): ${hostonly}"
    cd_info "  of which no file of lib/cd is among them: ${hostlib}"
    if [[ "$skip" == 1 ]]; then
        cd_info "compose_state was not evaluated (--no-compose)"
    fi
    return 0
}
