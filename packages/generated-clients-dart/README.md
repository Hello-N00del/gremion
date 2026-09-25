# @gremion/generated-clients-dart

Generated Dart clients for Gremion's first-party HTTP surfaces (TRD-405: "The
TypeScript and Dart clients of every spec shall be generated from it; no
hand-written client of a specified surface shall be merged"). This is the Dart
sibling of `packages/generated-clients` (TypeScript, TASK-030). It follows the
same pattern but shares no code with it.

| Directory | What it is |
|---|---|
| `<surface>/` (e.g. `kernel-governance/`) | One pub package per `type: openapi`, `status: active` entry of `contracts/registry.json`, named `gremion_<registry_name_snake>_client`. **Generated output only; never edit it by hand.** |
| `src/`, `tools/`, `package.json` | The Node side that writes and checks those packages. |
| `.gen-work/` (gitignored) | Generator staging dirs and the Docker-side pub cache. |

AsyncAPI entries are registered but excluded (TRD-409; same scope as the TS
precedent `packages/generated-clients/src/codegen.ts`).

## Commands

```sh
pnpm --filter @gremion/generated-clients-dart images:pull   # pre-pull the pinned images (own step)
pnpm --filter @gremion/generated-clients-dart generate      # regenerate every surface package
pnpm --filter @gremion/generated-clients-dart codegen:check # TRD-405 gate (standalone)
pnpm --filter @gremion/generated-clients-dart test          # unit + the one real-toolchain integration test
pnpm --filter @gremion/generated-clients-dart typecheck
```

`generate` and `codegen:check` run `images:pull` first. Both take about 70 s per
surface through Docker, mostly compiling build_runner.

## Pinned toolchain

The generator and the Dart SDK are resolved in this order: a local binary at the
pinned version, then the digest-pinned Docker image, and otherwise the command
**fails closed**. The rules live in `src/tools.ts`:

| Tool | Local | Docker fallback (index digest, resolved 2026-09-25) |
|---|---|---|
| openapi-generator **7.12.0** (`dart-dio`) | `openapi-generator-cli` / `openapi-generator` on PATH whose `version` prints exactly `7.12.0` | `openapitools/openapi-generator-cli:v7.12.0@sha256:338dc617d26fb4a515891dee8a5c345ad302e191c6010c6a1f77ed6f6ff7476a` |
| Dart SDK **3.11.5** (stable) | `$DART_BIN`, then `dart` on PATH, reporting SDK 3.11.5 | `dart:3.11.5@sha256:03b628160f6906098352a6d9c97a147afaa28cf4af97cb588aa33655d6ec3125` |

A local tool at another version is ignored and the run falls through to Docker.
A `$DART_BIN` that is set but wrong fails the run and never falls through.
Docker counts only if its daemon answers and the image is already present; runs
use `--pull never`, the generator runs with `--network none`, and containers
are named `t124-gen-<pid>-<rand>`, run with `--rm`, and are removed with
`docker rm -f` in a `finally`. `docker run` exits 125/126/127 mean the engine
did not run the tool; they are never read as the tool's verdict. To bump a pin,
change the tag and digest together in `src/tools.ts`, regenerate, and commit
the diff.

## The pipeline (`src/pipeline.ts`)

The writer and the check call the same function, one per surface:

1. Stage the spec under `.gen-work/`. The spec is LF-normalised, and 3.0-style
   `nullable: true` becomes 3.1 `type: [T, "null"]` (see below).
2. `openapi-generator generate -g dart-dio` with
   `--global-property apiTests=false,modelTests=false,apiDocs=false,modelDocs=false`
   and a seeded `.openapi-generator-ignore` covering `test/**`, `doc/**` and the
   generator's `.gitignore`, which would ignore `pubspec.lock`.
3. Overlay a package-local `.gitattributes` (`* text eol=lf`), `.gitignore`
   (`.dart_tool/`, `build/`) and `.generated-from` (the spec path and its
   sha256).
4. `dart pub get --enforce-lockfile` against the committed `pubspec.lock`. A new
   surface seeds its lock from an existing surface, so all packages resolve
   the same versions.
5. `dart run build_runner build --delete-conflicting-outputs`. The `*.g.dart`
   outputs are committed. build_runner 2.16.1 (locked) ignores the flag and warns that
   it was removed.
6. `dart analyze --no-fatal-warnings`. The gate requires exit 0, a summary
   line, zero `error -` lines, and parsed lines that add up to the summary.
   Warnings are counted and logged. `analysis_options.yaml` must not exclude
   `lib/**` or re-map a diagnostic that is not on the reviewed allowlist. The
   same allowlist applies to in-file `// ignore:` codes.
7. The resulting file set must equal `.openapi-generator/FILES` plus the
   generator meta, the build_runner outputs and the overlay. Any other file
   fails the run.

**Nullability.** openapi-generator 7.12.0 ignores `nullable` in OpenAPI 3.1
mode, and the committed specs are 3.1.0 written with the 3.0 keyword. Without
step 1, required nullable fields such as `child_term` would come out
non-nullable and fail to deserialize a `null`. The rewrite changes the
generator input only and never the committed spec. A `nullable` it cannot map
faithfully fails the run: one without a `type`, or one with an `enum`. Once the
specs use the 3.1 spelling, the rewrite does nothing.

## What `codegen:check` fails on

- A registered surface with no package, or a stale `.generated-from` (the spec
  changed and was not regenerated).
- Any extra, missing or differing file anywhere in a surface package. The whole
  file set is regenerated and compared byte for byte; only `.dart_tool/` is
  skipped.
- A directory under `packages/generated-clients-dart/` that is not a
  registered surface or the Node tooling, and Dart files in `src/` or `tools/`.
- A hand-written client: any `*.dart` outside the surface packages
  (`apps/mobile/**` included, tracked or untracked-not-ignored) that contains a
  path from any registered OpenAPI spec's `paths`. Path parameters match
  whatever gets interpolated (`{id}`, `$id`, `${x.id}`, `42`).
- Vacuity. The check reports `N of M`, where M is the number of openapi+active
  registry entries. It fails unless M >= 1 and N == M.
- A missing generator or SDK at the pinned versions, or a failure in pub get,
  build_runner or analyze.

## Not covered here

- Registration in the `verify` suite (TASK-045). Until then the gate is the
  standalone `codegen:check` above.
- The StuRaOS mobile app's hand-written client (`mobile/lib/services/api_client.dart`,
  a different repository), which this check cannot see.
- The generated pubspecs carry no `publish_to: none`, because the generator
  template has no such option and generated files are never patched.
  Publishing needs an explicit `dart pub publish`.
