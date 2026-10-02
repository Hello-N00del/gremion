<script lang="ts">
  import PageTitle from '$lib/components/PageTitle.svelte'
  import type { PageData } from './$types'
  import { goto } from '$app/navigation'
  import { Alert } from '$lib/components/ui/alert'
  import { Button } from '$lib/components/ui/button'

  let { data }: { data: PageData } = $props()

  // Refresh the WOPI access token this many ms before it expires. Collabora
  // accepts Action_RefreshAuth at any point; refreshing 5 minutes early keeps
  // the editing session uninterrupted in the common case.
  const REFRESH_THRESHOLD_MS = 5 * 60 * 1000
  // Fall back to the visible "session expiring" banner if a refresh fetch
  // fails and we're now within this window of expiry.
  const WARN_THRESHOLD_MS = 30 * 60 * 1000

  let iframeError = $state(false)
  let iframeEl = $state<HTMLIFrameElement | null>(null)

  // data.tokenTtl is a Unix epoch in SECONDS (Nextcloud richdocuments returns
  // doc.token_ttl as an absolute expiry timestamp, not a relative duration —
  // see nextcloud-client.ts:getCollaboraEditorUrl). Convert to ms here so the
  // tick loop can compare against Date.now() in ms, and so the refreshed value
  // we postMessage to Collabora as access_token_ttl is in the unix-ms units
  // its WOPI host frame expects. Mutable so silent refresh can extend the
  // deadline without a full reload.
  // svelte-ignore state_referenced_locally
  let expiresAt = $state(data.tokenTtl * 1000)
  const collaboraOrigin = $derived(new URL(data.editorUrl).origin)

  let showExpiryWarning = $state(false)
  let refreshFailed = $state(false)
  let saveError = $state<string | null>(null)

  async function tryRefreshToken() {
    try {
      const res = await fetch(`/api/files/edit-token/${data.paramPath}`)
      if (!res.ok) throw new Error(`refresh failed ${res.status}`)
      const body = (await res.json()) as { token: string; tokenTtl: number; editorUrl: string }
      iframeEl?.contentWindow?.postMessage(
        JSON.stringify({
          MessageId: 'Action_RefreshAuth',
          Values: {
            access_token: body.token,
            access_token_ttl: body.tokenTtl * 1000,
          },
        }),
        collaboraOrigin,
      )
      expiresAt = body.tokenTtl * 1000
      refreshFailed = false
    } catch {
      // Refresh path failed; fall back to the visible banner so the user can
      // save manually before the session expires.
      refreshFailed = true
    }
  }

  $effect(() => {
    function tick() {
      const remaining = expiresAt - Date.now()
      if (remaining < REFRESH_THRESHOLD_MS && !refreshFailed) {
        void tryRefreshToken()
      }
      showExpiryWarning = remaining < WARN_THRESHOLD_MS && refreshFailed
    }
    tick()
    const interval = setInterval(tick, 60_000)
    return () => clearInterval(interval)
  })

  // Collabora postMessage protocol — we listen for both close requests and
  // save responses. App_Close_Requested fires after any save-or-discard
  // prompt; Action_Save_Resp surfaces save failures we'd otherwise swallow.
  $effect(() => {
    function handleMessage(e: MessageEvent) {
      // #259-1: only trust postMessages from the Collabora editor origin.
      // Without this a page that frames/holds a handle to this window could
      // spoof App_Close_Requested (forced navigation) or a fake save-error
      // banner. Mirrors VideoCallPip.svelte's elementCallOrigin guard.
      if (e.origin !== collaboraOrigin) return
      if (typeof e.data !== 'string') return
      try {
        const msg = JSON.parse(e.data) as {
          MessageId?: string
          Values?: { success?: boolean; result?: string }
        }
        if (msg.MessageId === 'App_Close_Requested') {
          goto(data.backPath)
        } else if (msg.MessageId === 'Action_Save_Resp' && msg.Values?.success === false) {
          saveError = msg.Values.result ?? 'Speichern fehlgeschlagen — bitte erneut versuchen.'
        }
      } catch { /* not JSON */ }
    }
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  })

  const iframeSrc = $derived(`${data.editorUrl}&closebutton=1&lang=de`)

  function handleIframeError() {
    iframeError = true
  }

  function reload() {
    window.location.reload()
  }

  function requestClose() {
    if (iframeEl?.contentWindow) {
      iframeEl.contentWindow.postMessage(JSON.stringify({ MessageId: 'UI_Close' }), collaboraOrigin)
    }
    goto(data.backPath)
  }
</script>

<PageTitle title={data.fileName} />

<!-- min-height: 0 lets the iframe fill the remaining flex height correctly on
     short viewports. Without it, the iframe overflows the viewport on heights
     under ~700px. -->
<div class="flex flex-col" style="height: 100vh; min-height: 0;">
  <div class="flex items-center gap-3 px-4 py-2 border-b bg-paper shrink-0">
    <Button variant="ghost" size="sm" onclick={requestClose}>
      ← Zurück zu Dateien
    </Button>
    <span class="text-sm font-medium truncate">{data.fileName}</span>
  </div>

  {#if saveError}
    <Alert variant="destructive" class="rounded-none border-x-0 shrink-0">
      <div class="flex items-center justify-between gap-3">
        <span>{saveError}</span>
        <Button variant="link" size="sm" onclick={() => saveError = null} class="h-auto p-0">
          Schließen
        </Button>
      </div>
    </Alert>
  {/if}

  {#if showExpiryWarning}
    <Alert class="rounded-none border-x-0 shrink-0">
      <div class="flex items-center justify-between gap-3">
        <span>Sitzung läuft bald ab — bitte speichern und Seite neu laden.</span>
        <Button variant="link" size="sm" onclick={reload} class="h-auto p-0">
          Neu laden
        </Button>
      </div>
    </Alert>
  {/if}

  {#if iframeError}
    <div class="flex flex-col items-center justify-center flex-1 gap-4 p-8">
      <Alert variant="destructive" class="max-w-md">
        Editor konnte nicht geladen werden — bitte versuche es später erneut.
      </Alert>
      <Button onclick={reload}>Neu laden</Button>
    </div>
  {:else}
    <iframe
      bind:this={iframeEl}
      src={iframeSrc}
      class="flex-1 w-full border-0"
      style="min-height: 0;"
      title={data.fileName}
      onerror={handleIframeError}
      allow="clipboard-read; clipboard-write"
    ></iframe>
  {/if}
</div>
