# Code map

The control panel shows a map of the Gremion code at `/codemap` (page "Code-Karte"). A program makes the map from
the code while the image is built. Nothing is generated inside the repository and no generated file is committed.

| File | Job |
| --- | --- |
| `extract.mjs` | reads the code and writes a graph (`--tree` for a folder without git, `--deps <dir>` for `typescript`) |
| `resolve.mjs` | joins `ste-text.json` to the graph by file and function name, never by line number |
| `build.mjs` | makes `code-map.html` and `status.json` from a graph, a commit and the text |
| `leak-scan.mjs` | refuses a page that holds an address, host name, key or local path (the kernel repo is public) |
| `image-step.sh` | the image build step: never exits non-zero, always leaves a valid `status.json` |
| `check.mjs` | the CI check: lists what does not match, blocks only on a leak or a crash |
| `ste-lint.mjs` | a rule check of `ste-text.json` (not a certified ASD-STE100 checker) |

## What "stale" means

`ste-text.json` holds the written text. A walkthrough step names its code as `{ "text", "file", "function" }` (a
function node with this file and this name) or as `{ "text", "nodeId" }` (a page, route, table or file node, whose
id holds no line number). A step that matches nothing in the graph is **stale**. A stale step is left out of the
example and the page says so, in the example and on the home view. The same holds for text of an area that is not in
the code now (stale area). An area in the code with no text is **undescribed** and shows its name.
A walkthrough with no live step is left out of the lists. A stale text never stops a build.

## How to refresh the text

1. Run `pnpm --filter control-panel codemap:check` (or `node codemap/check.mjs` in `apps/control-panel`). It lists the
   stale steps with walkthrough, step number, file, function and text, the stale and undescribed areas, ambiguous
   steps (two functions of one file with one name: the lowest line is used) and the number of STE findings.
2. Change `file` and `function` of the step to the new name, or write a new step. For an area, change the id in
   `areas` or write the text for the new area. Keep the Simplified Technical English rules (`node codemap/ste-lint.mjs
   codemap/ste-text.json <graph.json>`, the graph is the file that `extract.mjs --out` wrote).
3. Never write a host name, address, key or local path in the text. `leak-scan.mjs` finds them, and the page is not
   made if it finds one.

CI runs the same check in the job `codemap-stale`. The job never blocks a merge.

## What the image does

`image-step.sh <src> <out> <deps>` reads the commit without git (`.git/HEAD`, a loose ref or `packed-refs`, else
`unknown`), runs the extractor with a 300 s limit, builds the page and removes `graph.json`. On any failure it writes
`status.json` with `"ok": false` and a fixed reason, and removes a partial page. The panel reads `status.json` and
`code-map.html` from `CODEMAP_DIR` (default `/app/codemap`), shows the reason when there is no map, and serves
the page in a sandboxed iframe. `apps/control-panel/Dockerfile.dockerignore` is the allow-list of the build context
for this image, and `codemap/dockerignore.test.mjs` checks it against `.gitignore` and against the areas of the map.

BuildKit is the supported builder for this image. Under `DOCKER_BUILDKIT=0` (the legacy builder) the allow-list is
ignored and the root `.dockerignore` applies. That file filters far fewer secret classes (no key, certificate,
keystore, ssh key, kubeconfig or backups rules, for example), so such a file can land in a discarded builder layer
(the `COPY . /codemap-src` layer of the builder stage). It never reaches the runner stage, which copies only
`code-map.html` and `status.json`. The commit then reads `unknown` and the map has fewer L0 files, and nothing fails.
