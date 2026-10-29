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

1. Stage the spec under `.gen-work/`. The spec is LF-normalised, and the
   generator input is normalised for OpenAPI 3.1 (see below).
2. `openapi-generator generate -g dart-dio`, run offline, with:
   - `--global-property apiTests=false,modelTests=false,apiDocs=false,modelDocs=false`;
   - a seeded `.openapi-generator-ignore` covering `test/**`, `doc/**` and the
     generator's `.gitignore`, which would ignore `pubspec.lock`;
   - `serializationLibrary=built_value`, `dateLibrary=core`,
     `enumUnknownDefaultCase=true` (a server enum value the client does not
     know decodes to a fallback case) and `pubPublishTo=none` (these clients
     are private).
3. Overlay a package-local `.gitattributes` (`* text eol=lf`), `.gitignore`
   (`.dart_tool/`, `build/`) and `.generated-from` (the spec path and its
   sha256).
4. `dart pub get --enforce-lockfile` against the committed `pubspec.lock`. The
   writer re-resolves with plain `pub get` only when the committed lock no
   longer satisfies the pubspec, for example after a generator bump. Even then
   it refuses any package whose version stayed but whose sha256 changed. The
   check always enforces, then compares the lock byte for byte. A new surface
   seeds its lock from an existing surface. **To re-resolve on purpose,
   delete the surface's `pubspec.lock` and run `generate`.**
5. `dart run build_runner build --delete-conflicting-outputs`. The `*.g.dart`
   outputs are committed. build_runner 2.16.1 (locked) ignores the flag and
   warns that it was removed.
6. `dart analyze --no-fatal-warnings`. The gate requires exit 0, a summary
   line, zero `error -` lines, and parsed lines that add up to the summary.
   Warnings are counted and logged. The run also fails on any of these:
   - an `analysis_options.yaml` exclude that is not a plain `test/` or `doc/`
     glob;
   - a remap of a diagnostic that is not on the reviewed allowlist;
   - an in-file `// ignore:` code that is not on the allowlist;
   - a string `'null'` default in `lib/`.
7. The resulting file set must equal `.openapi-generator/FILES` plus the
   generator meta, the build_runner outputs and the overlay. Any other file
   fails the run.

Every tool run has a 20-minute wall-clock limit. A run that times out is
reported as not having finished, never as a result.

### OpenAPI 3.1 normalisation (`src/spec-normalize.ts`)

openapi-generator 7.12.0's 3.1 support ("still in beta", as it logs) gets
several spellings wrong. The committed specs are 3.1.0 but use 3.0
spellings. These rewrites apply to the generator input only and never to the
committed spec. Each was reproduced on the pinned image:

| Spec says | Generator alone | Normalised to |
|---|---|---|
| `type: T, nullable: true` | ignores `nullable`, so a required field becomes non-nullable and fails to decode `null` | `type: [T, "null"]` |
| `nullable` + `default: null` | the STRING default `'null'`, sent on every request | the default is dropped |
| `const: true` (typed or not) | `JsonObject?`, or a single-value EnumClass with wire name `'true'` that cannot decode a JSON `true` | the type only (`bool`) |
| `oneOf`/`anyOf: [{type: "null"}, T]` | an invented `Null` model (`ModelNull`) whose file is never written, so the package does not analyse | a scalar `T`: `type: [T, "null"]`; an inline object `T`: hoisted to a component named `<Schema><Property>` (the generator's own inline name) and the property becomes `anyOf: [{$ref}, {type: "null"}]`, which generates `T?` |
| `additionalProperties: false` on an inline object | every property referencing the enclosing schema deserializes with `result.x = v` instead of `result.x.replace(v)`, a type error | dropped (a client never enforces it) |

A spelling it cannot map faithfully fails the run: `nullable` without a type,
`nullable` next to `$ref`/`allOf`/`oneOf`/`anyOf`, `nullable` with an `enum`,
`default: null` on a non-nullable type, or a non-string `enum`. The walk
decides what counts as a schema by its position, so a property named
`default` and `responses.default` are still covered. Once the specs use the
3.1 spelling, the rewrites do nothing. Current counts for kernel-governance:
20 nullable, 5 `default: null`, 21 const; for kernel-core: 25 `oneOf`-null merged, 3 objects hoisted, 35 `additionalProperties: false` dropped.

## What `codegen:check` fails on

- A registered surface with no package, or a stale `.generated-from` (the spec
  changed and was not regenerated).
- Any extra, missing or differing file in a surface package. The whole
  committable file set is regenerated and compared byte for byte: tracked plus
  untracked-not-ignored files, including anything force-added under
  `.dart_tool/`. Ignored local clutter is not counted.
- A directory under `packages/generated-clients-dart/` that is not a
  registered surface or the Node tooling, and Dart files in `src/` or `tools/`.
- A hand-written client: any `*.dart` outside the surface packages
  (`apps/mobile/**` included) that contains a path from any registered OpenAPI
  spec's `paths`. Path parameters match whatever gets interpolated (`{id}`,
  `$id`, `${x['id']}`, `42`). The scan also sees a path that was assembled:
  - from string consts (`'$base/committees/$id'`);
  - by `+` concatenation or adjacent literals;
  - from segment lists (`pathSegments: [...]`, `[...].join('/')`,
    `path.url.join(...)`) and `StringBuffer()..write(...)` chains;
  - without a leading slash;
  - as a tail behind a base URL that carries the prefix
    (`baseUrl: '…/api'` + `'/governance/committees'`), provided the tail
    holds at least two literal segments. Shorter tails such as
    `/groups/{id}` are ordinary route, asset and document-id text too often.

  Known gaps of this text scan: paths computed at runtime; segments behind
  getters, maps or `${'literal'}`; unicode escapes; and a remainder behind a
  base URL with fewer than two literal segments (e.g. `'/health'`,
  `'/groups/$id'`). Router patterns (`'/groups/:id'`) are deliberately not
  matched. The scan also fails if it saw no path keys, or if its file
  listing does not include the generated packages.
- Vacuity. The check reports `N of M`, where M is the number of openapi+active
  registry entries. It fails unless M >= 1 and N == M. Registry entries with an
  unknown `status`, a `type` that disagrees with the document, or a name that
  collides with the tooling make the check throw.
- A missing generator or SDK at the pinned versions, or a failure in pub get,
  build_runner or analyze.

## Known limitations and residuals

- Registration in the `verify` suite (TASK-045). Until then the gate is the
  standalone `codegen:check` above.
- The StuRaOS mobile app's hand-written client (`mobile/lib/services/api_client.dart`,
  a different repository), which this check cannot see.
- dart-dio has no JsonNullable option, so an optional nullable field that is
  `null` is omitted rather than sent as `null`. A PATCH cannot clear such a
  field; the spec would have to make it required-nullable.
- The generated pubspec keeps the template's `sdk: '>=2.18.0 <4.0.0'`, while
  the committed lock needs Dart >= 3.11. Consumers resolve their own floor.
- POSIX-first: on Windows, a PATH `.cmd` wrapper for the generator or Dart is
  not run (no shell), so resolution falls back to the pinned Docker images.
  This includes Flutter's `bin/dart.bat`: set `$DART_BIN` to the SDK's
  `bin/cache/dart-sdk/bin/dart.exe` instead, or it fails closed. The
  tool-resolution unit tests inject a spawn that runs Node-script fakes, so
  `test:unit` runs green on Windows and Linux alike.
