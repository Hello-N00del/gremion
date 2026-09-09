import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { modal } from './modal'

/**
 * The modal action is framework-agnostic (operates on a raw DOM node), so we can
 * drive it directly in jsdom without mounting a Svelte component.
 */

function makeDialog(html: string): { container: HTMLElement; cleanup: () => void } {
  const container = document.createElement('div')
  container.setAttribute('role', 'dialog')
  container.tabIndex = -1
  container.innerHTML = html
  document.body.appendChild(container)
  return {
    container,
    cleanup: () => container.remove(),
  }
}

describe('modal action', () => {
  let trigger: HTMLButtonElement

  beforeEach(() => {
    document.body.innerHTML = ''
    document.body.style.overflow = ''
    // A trigger button that holds focus before the dialog opens.
    trigger = document.createElement('button')
    trigger.textContent = 'open'
    document.body.appendChild(trigger)
    trigger.focus()
  })

  afterEach(() => {
    document.body.innerHTML = ''
    document.body.style.overflow = ''
  })

  it('locks body scroll while active and restores it on destroy', () => {
    const { container } = makeDialog('<button>ok</button>')
    const action = modal(container)
    expect(document.body.style.overflow).toBe('hidden')

    action.destroy()
    expect(document.body.style.overflow).toBe('')
  })

  it('moves focus to the first focusable element on activate', async () => {
    const { container } = makeDialog('<button id="first">first</button><button>second</button>')
    const action = modal(container)
    // focus is deferred via queueMicrotask
    await Promise.resolve()
    expect(document.activeElement?.id).toBe('first')
    action.destroy()
  })

  it('focuses the container itself when there is nothing focusable inside', async () => {
    const { container } = makeDialog('<p>just text</p>')
    const action = modal(container)
    await Promise.resolve()
    expect(document.activeElement).toBe(container)
    action.destroy()
  })

  it('restores focus to the trigger on destroy', async () => {
    const { container } = makeDialog('<button>ok</button>')
    const action = modal(container)
    await Promise.resolve()
    action.destroy()
    expect(document.activeElement).toBe(trigger)
  })

  it('wraps focus from last to first element on Tab', () => {
    const { container } = makeDialog('<button id="a">a</button><button id="b">b</button>')
    const action = modal(container)
    const last = container.querySelector<HTMLButtonElement>('#b')!
    last.focus()

    const evt = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    container.dispatchEvent(evt)

    expect(evt.defaultPrevented).toBe(true)
    expect(document.activeElement?.id).toBe('a')
    action.destroy()
  })

  it('wraps focus from first to last element on Shift+Tab', () => {
    const { container } = makeDialog('<button id="a">a</button><button id="b">b</button>')
    const action = modal(container)
    const first = container.querySelector<HTMLButtonElement>('#a')!
    first.focus()

    const evt = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    })
    container.dispatchEvent(evt)

    expect(evt.defaultPrevented).toBe(true)
    expect(document.activeElement?.id).toBe('b')
    action.destroy()
  })

  it('reference-counts the scroll lock across stacked dialogs', () => {
    const a = makeDialog('<button>a</button>')
    const b = makeDialog('<button>b</button>')
    const actionA = modal(a.container)
    const actionB = modal(b.container)
    expect(document.body.style.overflow).toBe('hidden')

    // Closing one still leaves the lock in place for the other.
    actionA.destroy()
    expect(document.body.style.overflow).toBe('hidden')

    actionB.destroy()
    expect(document.body.style.overflow).toBe('')
  })
})
