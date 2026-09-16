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

- The StuRa tree carries the annotated tag `extraction-source` — that exact
  string — at that commit. `ARCHIVED.md` in the archived StuRa tree names it
  verbatim. The tag must be present on that repository's `origin` before any
  module repository is extracted, because every extraction runs against a clone;
  `git ls-remote --tags origin extraction-source` returning nothing means the
  freeze exists only on one machine.
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
