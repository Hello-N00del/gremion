// The German waiting page for the 503 answers a person can meet while the app starts:
//   'booting'  : the process is up, boot (migrations, fleet) has not finished;
//   'tenant'   : the host is known, but this tenant's data plane is not ready yet;
//   'tenant-failed' : the tenant's preparation failed. Waiting does not fix that, so this page
//                 does not reload itself (a reload would also start another attempt each time).
// Before this, both were bare English text. A browser does not retry a 503, so the person saw
// "Service Unavailable: ..." and had to know to reload. This page says what is happening in
// German and, except for 'tenant-failed', reloads itself (meta refresh, matching Retry-After).
// Machine callers keep the
// status code and the Retry-After header, which is all they read.
//
// No dependencies, no request data in the output: nothing here can echo user input.

export type WaitingKind = 'booting' | 'tenant' | 'tenant-failed'

const COPY: Record<WaitingKind, { title: string; text: string; refresh: boolean }> = {
  booting: {
    title: 'Die Anwendung startet gerade',
    text: 'Die Anwendung wird gerade gestartet. Das dauert meist nur wenige Sekunden.',
    refresh: true,
  },
  tenant: {
    title: 'Ihr Bereich wird vorbereitet',
    text: 'Ihr Bereich wird gerade vorbereitet. Das dauert meist nur wenige Sekunden.',
    refresh: true,
  },
  'tenant-failed': {
    title: 'Ihr Bereich ist gerade nicht verfügbar',
    text: 'Die Vorbereitung Ihres Bereichs ist nicht abgeschlossen worden. Bitte versuchen Sie es in einigen Minuten erneut. Besteht das Problem weiter, melden Sie es der Betreuung Ihrer Installation.',
    refresh: false,
  },
}

const RETRY_SECONDS = 5
const RETRY_SECONDS_FAILED = 60

export function waitingPageHtml(kind: WaitingKind): string {
  const { title, text, refresh } = COPY[kind]
  const refreshMeta = refresh ? `<meta http-equiv="refresh" content="${RETRY_SECONDS}">` : ''
  const refreshNote = refresh
    ? '<p class="muted">Diese Seite lädt sich in ein paar Sekunden von selbst neu.</p>'
    : ''
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refreshMeta}
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
${refreshNote}
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
      'Retry-After': String(kind === 'tenant-failed' ? RETRY_SECONDS_FAILED : RETRY_SECONDS),
      'Cache-Control': 'no-store',
    },
  })
}
