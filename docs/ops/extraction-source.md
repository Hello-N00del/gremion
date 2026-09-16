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
  verbatim.
- Every `module.json` echoes the same value under `"extractionSource"`, as 40
  lowercase hexadecimal characters. It is a per-module field: the internal
  modules endpoint serialises it per enabled module, and the agreement check
  across modules is the assembler's.
- `scripts/check-extraction-source.mjs` refuses a build in which any
  `module.json` omits the key, carries a value that is not 40 lowercase hex, or
  disagrees with this file. `make lint-extraction-source` runs it, and the
  assembler must import it. The agreement check itself lives in
  `scripts/lib/extraction-source.mjs` and is imported — never re-implemented —
  by the shared schema validator.

Changing this SHA re-opens the split: each module repository's blob-equality
check is taken against it, and the StuRa tree's archive record names it.
