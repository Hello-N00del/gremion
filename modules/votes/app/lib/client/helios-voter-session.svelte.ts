import { browser } from '$app/environment'

export type SessionState = 'checking' | 'ready' | 'needed'

export interface SessionOptions {
  heliosBase: string
  callbackPath: string
  electionUuid: string
  gremionUiOrigin: string
}

export interface HeliosVoterSession {
  readonly state: SessionState
  destroy(): void
}

const TIMEOUT_MS = 3000

export function createHeliosVoterSession(opts: SessionOptions): HeliosVoterSession {
  let state = $state<SessionState>('checking')

  if (!browser) {
    return {
      get state() { return state },
      destroy() {},
    }
  }

  const callbackUrl = `${opts.gremionUiOrigin}${opts.callbackPath}`
  const oidcStartUrl =
    `${opts.heliosBase}/auth/start/keycloak_oidc` +
    `?return_url=${encodeURIComponent(callbackUrl)}&prompt=none`

  const iframe = document.createElement('iframe')
  iframe.src = oidcStartUrl
  iframe.style.display = 'none'
  iframe.dataset.heliosAuth = '1'
  document.body.appendChild(iframe)

  function onMessage(ev: MessageEvent): void {
    if (ev.origin !== opts.gremionUiOrigin) return
    const d = ev.data as { type?: string; status?: string }
    if (d?.type === 'helios_auth' && d?.status === 'ok') {
      state = 'ready'
      cleanup()
    }
  }

  window.addEventListener('message', onMessage)

  const timer = setTimeout(() => {
    if (state === 'checking') {
      state = 'needed'
      cleanup()
    }
  }, TIMEOUT_MS)

  function cleanup(): void {
    clearTimeout(timer)
    window.removeEventListener('message', onMessage)
    iframe.remove()
  }

  return {
    get state() {
      return state
    },
    destroy: cleanup,
  }
}
