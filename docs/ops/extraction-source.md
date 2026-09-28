# Extraction source (frozen)

Every `gremion-module-<id>` repository — its `app/` tree, its `service/` leaf, its
compose fragment and its migrations — is extracted from one commit of the StuRa
tree (the StuRa vertical, archived after the split). The split runs across ten
repositories over several days; without one frozen source it can straddle two
source states, and nothing downstream would notice.

The frozen commit, recorded once, here:

```
extraction-source: f276af5925abacdcfd05f6613fc11afff2d804c5
```

- In-tree modules (TASK-200): `modules/<id>/` is copied from a LATER StuRa commit than the SHA above, the annotated tag `extraction-source-f2` (peels to `d0c656d0b266f3a1741f34454e0061bc5078c3f4`; it superseded `extraction-source-f1` at `0c9d342e9a1f9785b6f976719008134237198d0d`, which predates R25-4 S-C), blob-checked by `scripts/check-module-source-parity.mjs` (output in `docs/ops/module-source-parity*.txt`); that tag's `gremion-ui/src/lib/server/calendar/notification-scheduler.ts` carries the civitas-modules 1295a40 fix, which enters `modules/calendar/app/` with TASK-205.

- The StuRa tree carries the annotated tag `extraction-source` — that exact
  string — at that commit. `ARCHIVED.md` in the archived StuRa tree names it
  verbatim. The tag must be present on that repository's `origin` before any
  module repository is extracted, because every extraction runs against a
  clone: a local-only tag does not resolve there, and the silent recovery is a
  fall back to `master` — the two-source-states straddle this file exists to
  prevent, with no artefact saying it happened. That is a post-condition on
  another repository, so it is checked rather than asserted:

  ```bash
  # publish the freeze (once, from the StuRa tree)
  git push origin refs/tags/extraction-source

  # assert it landed: exit 1 while the remote has no such tag, while the tag
  # is lightweight, or while it peels to a commit other than the one above
  node scripts/check-extraction-source.mjs --allow-zero \
    --verify-remote https://github.com/Hello-N00del/StuRaOS
  ```

  `--verify-remote` is deliberately NOT part of `make lint`: it needs the
  network and it is a post-condition on a repository the kernel does not own,
  so wiring it into every lint would make the kernel's build depend on another
  repository's push state. Note the ref pattern — `git ls-remote --tags
  <remote> extraction-source` filters out the peeled `^{}` line and so cannot
  tell an annotated tag from a lightweight one; the guard asks for
  `'refs/tags/extraction-source*'`.
- Every `module.json` echoes the same value under `"extractionSource"`, as 40
  lowercase hexadecimal characters. It is a per-module field: the internal
  modules endpoint serialises it per enabled module, and the agreement check
  across modules is the assembler's.
- `scripts/check-extraction-source.mjs` refuses a build in which any
  `module.json` omits the key, carries a value that is not 40 lowercase hex, or
  disagrees with this file. `make lint-extraction-source` runs it, and the
  assembler must import it — and call it; an import with no call site is
  refused. The agreement check itself lives in
  `scripts/lib/extraction-source.mjs` and is imported — never re-implemented —
  by the shared schema validator.
- The guard refuses to pass over nothing, and refuses to pass over a subset.
  Arguments are parsed strictly, so an unknown flag or a `--modules-root` whose
  value was dropped is an error rather than a silently ignored token; a
  `--modules-root` that is not a directory is an error even under
  `--allow-zero`; and a run that inspects no `module.json` at all must say
  `--allow-zero` and is reported as doc-only, never as agreement.
- Every **directory** under the modules root is a module, and a module
  directory that carries no `module.json` is refused by name. A manifest that
  was never written — or written as `Module.json`, `module.jsonc`,
  `module.json.tmpl` — is the strongest form of the straddle this file exists to
  refuse, because nothing in that module echoes the frozen SHA at all. So
  `--allow-zero` means "the root holds no module directory" (the zero-module
  assemble, which passes `--modules-root <dir> --allow-zero` explicitly), never
  "no manifests happened to be found", and the success line counts module
  directories: `N of N module directories under <dir> carry an agreeing
  module.json`.

Changing this SHA re-opens the split: each module repository's blob-equality
check is taken against it, and the StuRa tree's archive record names it.
