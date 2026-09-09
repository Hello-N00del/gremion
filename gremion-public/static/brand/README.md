# `static/brand/` — operator icon slot

`src/app.html` references three icon files from this directory. **The kernel
ships none of them.**

| File | Purpose | Size |
|---|---|---|
| `favicon-32.png` | browser tab / bookmarks | 32×32 PNG |
| `favicon-512.png` | high-DPI + install prompts | 512×512 PNG |
| `apple-touch-icon.png` | iOS home screen (iOS applies its own corner mask, so design it full-bleed) | 180×180 PNG |

Drop files with exactly those names here and they are served automatically — no
config change. `%sveltekit.assets%` resolves through `kit.paths.base`, so they
follow the portal when it is mounted under a base path (see `svelte.config.js`).

## Why the directory is empty

Gremion is an **unbranded** governance kernel that boots standalone; a product
built on it is one *instance*. The v12 design handover
produced a finished icon family, but it is built around that instance's "S"
mark. Shipping it in the kernel would put one organisation's glyph in every
self-hoster's browser tab — a wrong-attribution and trademark hazard, and the
same reason a deployment host, product name or marketing copy does not belong
in a shipped artefact. `scripts/kernel-hygiene-check.mjs` check i1 enforces the
host half of that across contracts/, docker/, k8s/, .github/, scripts/, test/
and docs/; the app source under `gremion-ui/` and `gremion-public/` is a named
residual there, not yet covered.

Until an operator drops files in, the three `<link>` elements in `app.html`
resolve to 404 — which is what the single `favicon.png` reference they replaced
already did, since this app has never had a `static/` directory.

If a neutral Gremion mark is ever commissioned, it belongs here (and in
`gremion-ui/static/brand/`) and this note should be shortened accordingly.

## Related

`<meta name="theme-color">` in `app.html` is set per surface from this app's own
`--paper` token in `src/app.css`. It is a palette value, not a mark, so the
kernel does carry it — keep the two in step if the token changes.
