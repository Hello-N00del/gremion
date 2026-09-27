# @gremion/tokens

The design tokens of the [Gremion](https://github.com/Hello-N00del/gremion)
governance kernel as one W3C Design Tokens (DTCG) **2025.10** document, the
build that turns them into CSS custom properties, and the OKLCH accent engine
(UX-030 to UX-035; TASK-082).

## What is in here

| Path | What it is |
|---|---|
| `tokens/gremion.tokens.json` | The base (light) set, three tiers: `core` -> `semantic` -> `component`. |
| `tokens/modes/dark.tokens.json` | The dark set; overrides semantic tokens only. |
| `tokens/gremion.resolver.json` | DTCG 2025.10 resolver: base set, then the `theme` modifier (`light` / `dark`). |
| `schema/2025.10/` | The DTCG 2025.10 JSON Schema bundles, vendored byte-for-byte (see `NOTICE.md`). |
| `src/engine/accent.js` | `instanceAccentVars(H)`: one hue in, the whole light/dark accent ramp out. Browser-safe, dependency-free; import it as `@gremion/tokens/engine`. |
| `src/validate.js` | Schema validation + no duplicate keys (no token has two `$value`s) + an explicit `$type` on every token. |
| `src/lint.js` | The tier lint: `component-to-core`, `upward-alias`, `unknown-alias`, `raw-value-outside-core`, `unknown-tier`. |
| `src/emit-css.js`, `src/build.js` | The CSS emitter, the per-palette override set and the stylesheet fences. |

## Rules the token file follows

- Colours are `{ "colorSpace", "components" }` objects (`oklch` or `srgb`),
  dimensions `{ "value", "unit" }` (`px`/`rem`), durations `{ "value", "unit" }`.
  No CSS strings anywhere; the schema rejects them.
- Only `core` holds literal values. `semantic` and `component` tokens are
  whole-value aliases, and aliases point downward only (a component token
  never aliases core directly).
- A token becomes a CSS custom property when it carries
  `"$extensions": { "org.gremion": { "css": "--name" } }`. An alias to such a
  token is emitted as `var(--name)`, so the runtime cascade (the per-tenant
  accent `<style>`, `html.cb-*`, `html.density-compact`, `html.radius-sharp`)
  reaches every consumer. `"handWritten": true` marks a variable a consumer
  still writes by hand (the v8 warm neutrals): it is referenced, never emitted,
  and a test keeps its value equal to the hand-written literal.
- A typography token emits the `font` shorthand under its name and its
  letter-spacing under `<name>-tracking`.
- Values are the v8 system unchanged. The identity step changes values in the
  JSON, never code.

## Build

```sh
pnpm --filter @gremion/tokens build                                   # validate, lint, write dist/
pnpm --filter @gremion/tokens build -- --write ../../gremion-ui/src/app.css
pnpm --filter @gremion/tokens check                                   # exit 1 when app.css is stale
pnpm --filter @gremion/tokens test                                    # node --test, zero-collection guarded
pnpm --filter @gremion/tokens typecheck
```

`dist/gremion.css` holds the `:root` and `.dark` declarations; `dist/palettes.json`
holds, for every hue in `core.hue` marked `palette`, exactly
`instanceAccentVars(H)` (the engine is called, never copied).

A consumer stylesheet carries two fence pairs, one directly inside `:root` and
one directly inside the first `.dark` rule:

```css
:root {
  /* tokens:generated:light:begin ... */
  /* tokens:generated:light:end */
}
.dark {
  /* tokens:generated:dark:begin ... */
  /* tokens:generated:dark:end */
}
```

`--write` rewrites only the lines between them; a missing, duplicated or
misplaced fence is an error, never an appended block.

## Decisions recorded here

- **Transform tool (UX-032, brief Q1):** a custom build. Alias resolution is
  well under the ~150-line threshold at which Style Dictionary would be used.
- **Flutter (UX-032, brief Q2):** web only for now. The JSON is Dart-emittable
  (plain colour objects, px dimensions); a Dart `ThemeData`/`ThemeExtension`
  emitter and the UX-032 contrast-parity test are a follow-up task. UX-032 is
  not closed here.
- **Component variables are declared on `:root`.** They are computed on the
  root element, where the theme store also toggles `.dark` and `cb-*`. A
  `.dark` class on a subtree (not used today) would need the component tier
  re-declared on that subtree.

## Licence

AGPL-3.0-only (see `LICENSE`). The vendored schemas under `schema/2025.10/`
carry the W3C licence stated in their `NOTICE.md`.
