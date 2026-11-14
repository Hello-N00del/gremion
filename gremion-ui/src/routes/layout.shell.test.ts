import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/svelte'
import { createRawSnippet } from 'svelte'

// The shell decision is made in the root layout from the pathname. A module can ask for a bare route
// (full viewport, no sidebar or header) through its layout slot; the files module does so for the
// document editor, so a phone gives the whole screen to the Collabora iframe.
const pageStore = vi.hoisted(() => ({ pathname: '/files' }))
vi.mock('$app/stores', async () => {
  const { readable } = await import('svelte/store')
  return {
    page: {
      subscribe: (run: (v: unknown) => void) =>
        readable({ url: new URL('http://localhost' + pageStore.pathname), route: { id: pageStore.pathname } }).subscribe(run)
    }
  }
})
vi.mock('$app/navigation', () => ({ onNavigate: vi.fn(), afterNavigate: vi.fn(), goto: vi.fn() }))
vi.mock('$lib/components/layout/AppShell.svelte', () => ({
  // A stub that marks the shell in the DOM and still renders the page inside it.
  default: function AppShellStub(anchor: Comment, props: { children: (a: Comment) => void }) {
    const marker = document.createElement('div')
    marker.setAttribute('data-testid', 'app-shell')
    anchor.before(marker)
    props.children(anchor)
  }
}))
// The messaging slot pulls in the call picture-in-picture, which reads public env at module load.
vi.mock('$lib/components/VideoCallPip.svelte', () => ({ default: function VideoCallPipStub() {} }))

import Layout from './+layout.svelte'

afterEach(() => cleanup())

function mountLayout(pathname: string) {
  pageStore.pathname = pathname
  const children = createRawSnippet(() => ({ render: () => '<main data-testid="page-body">page</main>' }))
  const data = {
    session: { user: { id: 'u1', name: 'Alice', roles: [], groups: [] } },
    nav: [],
    counts: { approvals: 0, liveVotes: 0, unread: 0 },
    brand: {},
    sourceUrl: ''
  }
  return render(Layout, { props: { data, children } as never })
}

describe('root layout shell', () => {
  it('wraps an ordinary page in the app shell', () => {
    const { queryByTestId } = mountLayout('/files')
    expect(queryByTestId('app-shell')).not.toBeNull()
    expect(queryByTestId('page-body')).not.toBeNull()
  })

  it('renders the document editor route without the app shell', () => {
    const { queryByTestId } = mountLayout('/files/edit/Protokolle/Sitzung.odt')
    expect(queryByTestId('page-body')).not.toBeNull()
    expect(queryByTestId('app-shell')).toBeNull()
  })
})
