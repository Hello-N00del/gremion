// The German waiting page for the two 503 answers a person can meet while the app starts:
//   'booting'  : the process is up, boot (migrations, fleet) has not finished;
//   'tenant'   : the host is known, but this tenant's data plane is not ready yet.
// Before this, both were bare English text. A browser does not retry a 503, so the person saw
// "Service Unavailable: ..." and had to know to reload. This page says what is happening in
// German and reloads itself (meta refresh, matching Retry-After). Machine callers keep the
// status code and the Retry-After header, which is all they read.
//
// No dependencies, no request data in the output: nothing here can echo user input.

export type WaitingKind = 'booting' | 'tenant'

const COPY: Record<WaitingKind, { title: string; text: string }> = {
  booting: {
    title: 'Die Anwendung startet gerade',
    text: 'Die Anwendung wird gerade gestartet. Das dauert meist nur wenige Sekunden.',
  },
  tenant: {
    title: 'Ihr Bereich wird vorbereitet',
    text: 'Ihr Bereich wird gerade vorbereitet. Das dauert meist nur wenige Sekunden.',
  },
}

const RETRY_SECONDS = 5

export function waitingPageHtml(kind: WaitingKind): string {
  const { title, text } = COPY[kind]
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="${RETRY_SECONDS}">
<title>${title}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f5f1; color: #1d1d1b; }
  main { max-width: 32rem; padding: 2rem; }
  h1 { font-size: 1.4rem; margin: 0 0 0.75rem; }
  p { margin: 0 0 0.5rem; line-height: 1.5; }
  .muted { color: #5b5b57; font-size: 0.9rem; }
</style>
</head>
<body>
<main>
<h1>${title}</h1>
<p>${text}</p>
<p class="muted">Diese Seite lädt sich in ein paar Sekunden von selbst neu.</p>
</main>
</body>
</html>
`
}

export function waitingResponse(kind: WaitingKind): Response {
  return new Response(waitingPageHtml(kind), {
    status: 503,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Retry-After': String(RETRY_SECONDS),
      'Cache-Control': 'no-store',
    },
  })
}
