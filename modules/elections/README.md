**English** | [Deutsch](./README.de.md)

# elections

Optional committee elections run on a Helios ballot server: create an election for a
committee, follow its state (draft, open, closed), and open the ballot. The module does not
run a statutory election, and a permanent notice says so on every `/elections` page.
Status: **supported** ([docs/modules.md](../../docs/modules.md)). It is an app half plus a
small library; there is no leaf service and no Dockerfile.

| | |
|---|---|
| Directory / `module.json` id | `elections` |
| Manifest id (`config.modules` key) | `elections` |
| Package | `elections-module` |
| Navigation segment | `/elections` (minimum role: member) |
| Leaf service | none (the votes leaf, [modules/votes](../votes/README.md), serves the combined list) |

## Layout

| Path | Contents |
|---|---|
| `app/` | The in-process half, overlaid onto `gremion-ui/src/`: pages, `/api/elections`, the Helios client and election store (`app/lib/server/elections/`), the backend port, the notice component, the vote aggregator types, the manifest, the seeder. |
| `src/notice/` | The enable-time notice text (`notice.ts`), as German prose in a Du and a Sie form, with its facts (`optional`, not enabled by default, does not run a statutory election). Exported by `src/index.ts`. |
| `test/` | `notice.test.ts` pins the wording against the phrasings the elections-scope document forbids; `notice-keys.test.ts` ties it to the host app's i18n catalogue. |

## Routes and API surface

| Route | Methods |
|---|---|
| `/elections`, `/elections/new`, `/elections/manage`, `/elections/[id]`, `/elections/[id]/manage`, `/elections/[id]/helios-cb` | pages |
| `/api/elections` | GET, POST |

The notice component is mounted by `app/routes/elections/+layout.svelte`.

## Migrations

None in this directory (`module.json` declares `database: null`). The table the module uses,
`committee_elections`, belongs to the kernel schema and is applied by the kernel migrations
whether or not the module is on; the manifest deliberately declares no `migrations`, because
a later kernel migration alters that table unconditionally.

## Configuration

| Variable | Used by | Meaning |
|---|---|---|
| `HELIOS_URL`, `PUBLIC_HELIOS_URL` | kernel app | Internal and browser-facing URL of the Helios server. |
| `HELIOS_SERVICE_EMAIL`, `HELIOS_SERVICE_PASSWORD` | kernel app | Service account the Helios client signs in with (named in `helios-client.ts`; the secret handling was not traced). |
| `VOTES_BACKEND` | kernel app | `inprocess` (default) or `service`; any other value is refused. |
| `VOTES_SERVICE_URL`, `INTERNAL_VOTES_SECRET` | kernel app | Base URL and shared secret of the votes leaf when the backend is `service`. |
| `PUBLIC_BASE_URL` | kernel app | Public base URL of the instance. |
| `TRACE_EXPORTER` | kernel app | Tracing exporter selection. |

## External services

- Helios, the election server. Its administration stays in the kernel app by design.

## Enabling and disabling

- Build: included in the default build.
- Per customer: not enabled unless named. The pilot create request does not name it
  ([pilot/module-defaults.md](../../docs/pilot/module-defaults.md)); `--enable elections`
  at creation, or the panel's `enable_module` request, turns it on.
- Instance setting: `config.modules.elections = false` answers `/elections` and
  `/api/elections` with the module-disabled surface. The `/votes` page then hides every Helios
  item.
- The wording of the notice and what it may and may not claim is fixed in
  [compliance/elections-scope.md](../../docs/compliance/elections-scope.md).

## Tests

- `pnpm --filter elections-module test` and `typecheck`.
- `test/notice-keys.test.ts` reads `gremion-ui/src/lib/i18n/messages/{de,en}.json`; it is
  the one coupled test listed in `modules/COUPLED-TESTS.json`, so a standalone checkout of
  the module must supply that catalogue or exclude the test.
- Tests under `app/` (client, aggregator, API routes, erasure) sit next to the code and are
  not collected by the package's `test` script.

## Not established from the code

- `docs/pilot/module-defaults.md` says the module is not shown to be off by default on a
  running system; this README makes no claim about that.
