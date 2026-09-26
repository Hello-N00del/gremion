# @gremion/fastify-service-template

Spec-first Fastify template for Gremion services (TASK-076, TRD-406, TRD-213).
The committed OpenAPI 3.1 document is the source of truth [D R19-D3]. The
template reads it and registers one route per `paths × methods` entry by
`operationId`. It never emits or rewrites a spec, and a service has no
hand-written route file.

```ts
import { createService } from '@gremion/fastify-service-template'

const app = createService({
  spec: new URL('../../contracts/kernel/openapi.governance.json', import.meta.url),
  handlers, // one handler per operationId, no more, no fewer
  config: { uploadCeilingBytes: process.env.UPLOAD_CEILING_BYTES },
})
```

## What `createService` guarantees

| Guarantee | Fails how |
|---|---|
| Routes come only from the spec (`src/loader.ts` is the only module that registers one) | grep test in `test/scaffold.test.ts` |
| Every operation has an `operationId` with exactly one handler, and every handler matches an operation | `ServiceBootError` naming each problem; no invented ids, no request-time stubs |
| An undeclared path answers 404 `application/problem+json`; a declared path with an undeclared method answers 404/405 (TRD-406) | no implicit HEAD routes (`exposeHeadRoutes: false`) |
| Request validation uses Ajv's JSON Schema 2020-12 dialect | an unknown schema keyword refuses to boot (`strictSchema`); valid 2020-12 constructs (union types, `required` with a `$ref`) load |
| Response schemas stay on | an undeclared response field is dropped; a response missing a required field is a 500 problem |
| Every declared request media type can be parsed | `application/json`, `text/plain`, `multipart/form-data` and any `+json` type are parsed (a `+json` type with Fastify's JSON parser and the same ceiling). Any other type refuses to boot, named, so no route answers 415 to a request that follows its spec |
| Paths are served exactly as written | a `servers[].url` with a base path (`/api/v1`) refuses to boot. Write full paths in `paths` and keep servers to origins |
| `GET /healthz` is served on every service | platform route, see below |
| Error bodies are RFC 9457 `application/problem+json` | `src/problem.ts` |

## Upload ceiling (TRD-213)

**Default: 50 MiB = 52 428 800 bytes of file payload** (`DEFAULT_UPLOAD_CEILING_BYTES`).
TRD-213 says "50 MB [A] provisional". The brief (§5 Q4) reads that as 50 MiB of
**file** payload: the multipart envelope does not count against it.

- One constant feeds both limits: Fastify's `bodyLimit` for non-multipart
  bodies, and `@fastify/multipart`'s `limits.fileSize` for files (with
  `throwFileSizeLimit: true`).
- Over the ceiling, the response is **413 `application/problem+json`** with
  `type: "urn:gremion:problem:payload-too-large"` and `limitBytes`. Both
  `FST_REQ_FILE_TOO_LARGE` and `FST_ERR_CTP_BODY_TOO_LARGE` map to it.
- A file over the ceiling is never truncated into a success. The file stream
  is destroyed with the 413 error as soon as busboy reports the limit, and a
  handler that swallows that error and answers 2xx is still answered 413.
  Handler code cannot raise the ceiling: a per-call `limits.fileSize` is
  clamped to it, though a lower per-call limit is kept.
- Override only through validated config: `config.uploadCeilingBytes`, or the
  scaffold's `UPLOAD_CEILING_BYTES` env var. The value must be a positive safe
  integer, or a string of decimal digits that names one. Anything else
  (`NaN`, `0`, `-1`, `1.5`, `'50MB'`, `''`, `null`) throws
  `InvalidUploadCeilingError` (`GREMION_INVALID_UPLOAD_CEILING`) at boot. The
  default applies only when the value is **unset**. An invalid value never
  falls back to it.
- The handler must stream the file (`for await (const chunk of part.file)`).
  The template never buffers a whole file.

`test/upload-ceiling.int.test.ts` covers this end to end. It uses a scaffolded
instance on a real socket and a streamed multipart upload.
52 428 800 B → 201 with the server's sha256 equal to the client's.
52 428 801 B → the typed 413.

## Scaffold

```sh
pnpm --filter @gremion/fastify-service-template scaffold --spec contracts/<x>.json --out services/<name>
```

Relative paths resolve against the directory you invoked pnpm from. The
scaffold emits `package.json` (with the `gremion.fastifyService` descriptor),
`tsconfig.json`, `src/index.ts` (`buildApp()`), `src/main.ts`,
`src/handlers/index.ts`, and one stub per `operationId` that answers
**501 problem+json** until you implement it. It emits no route file. The spec
is referenced by a relative path and never copied. The scaffold refuses a
non-empty output directory and any spec that `createService` would refuse.

## routes:check

```sh
pnpm --filter @gremion/fastify-service-template routes:check              # template self-check + every services/*/ template service
node packages/fastify-service-template/src/cli/routes-check.ts --service services/<name>
```

The check boots each service and reads its actual route table through the
`onRoute` collector, so hand-written routes inside plugins count. It diffs that
table against the spec's `(METHOD, path)` set. The check is **fail-closed**. It
fails, and names the cause, when:

- a route is registered that the spec does not declare
- a spec operation has no registered route
- a route is registered twice, or the spec declares two templates for one route shape
- the service fails to boot
- the spec declares 0 operations (vacuity)
- 0 services were checked

Only `PLATFORM_ROUTES` (today `GET /healthz`) is exempt, matched by method and
path. That list is the seam for later platform routes, for example TASK-035's
evict.

**Proposed `verify` registration (brief §5 Q2).** `scripts/verify/**` is owned by
TASK-045 and is not in this unit. When it exists, the orchestrator can register
this one line:

```sh
pnpm --filter @gremion/fastify-service-template routes:check
```

## Decisions (brief §5)

- **Q1 loader:** we wrote our own loader. `fastify-openapi-glue@4.11.5` was
  probed first and rejected. On the fixture it gave a multipart body a JSON
  body schema (every upload answered 400), invented an `operationId`, and
  stubbed a missing handler at request time instead of failing boot. See the
  header of `src/loader.ts`.
- **Q2 verify:** we ship the package script. See the proposed line above.
- **Q3 platform routes:** a single exported `PLATFORM_ROUTES` constant is
  exempted by name. A test checks that any other unspecified route fails,
  including `POST /healthz` and `GET /healthz/deep`.
- **Q4 "50 MB":** 50 MiB of file payload (above).
- **Q5 problem `type`:** `urn:gremion:problem:<slug>`, because TASK-083's scheme
  had not merged. **TASK-083 should align its scheme with this one**, or this
  table moves to TASK-083's scheme.

## Runtime notes

- The CLIs run from source (`node src/cli/*.ts`). They need Node's type
  stripping and `module.registerHooks`, which means Node ≥ 22.18. The
  repository pins Node 26. The published `dist/` needs only Node ≥ 22.
- Only local `$ref`s (`#/...`) are supported. Remote refs, dangling refs and
  ref cycles reached from `paths` refuse to boot, named.
