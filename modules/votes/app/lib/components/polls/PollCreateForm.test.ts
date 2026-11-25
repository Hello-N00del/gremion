import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/svelte'

// SvelteKit's `enhance` hands the form's submit callback { formData, cancel }; a cancelled submit never reaches the
// server. The stub mirrors that contract: it runs the callback on submit and records whether it was cancelled.
const sent: FormData[] = []
vi.mock('$app/forms', () => ({
  enhance: (form: HTMLFormElement, submit: (input: { formData: FormData; cancel: () => void }) => unknown) => {
    const onSubmit = (e: Event) => {
      e.preventDefault()
      const formData = new FormData(form)
      let cancelled = false
      submit({ formData, cancel: () => (cancelled = true) })
      if (!cancelled) sent.push(formData)
    }
    form.addEventListener('submit', onSubmit)
    return { destroy: () => form.removeEventListener('submit', onSubmit) }
  },
}))

import PollCreateForm from './PollCreateForm.svelte'

afterEach(() => {
  cleanup()
  sent.length = 0
})

async function submitWith(container: HTMLElement, options: string) {
  await fireEvent.input(container.querySelector('#title') as HTMLInputElement, { target: { value: 'Sommerfest' } })
  await fireEvent.input(container.querySelector('#options') as HTMLTextAreaElement, { target: { value: options } })
  await fireEvent.submit(container.querySelector('form') as HTMLFormElement)
}

describe('PollCreateForm duplicate options', () => {
  it('refuses a repeated option with a message naming it, and sends nothing', async () => {
    const { container } = render(PollCreateForm)
    await submitWith(container, 'Ja\nNein\nJa')
    const alert = container.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('„Ja“')
    expect(alert?.textContent).toContain('mehrfach')
    expect(sent).toHaveLength(0)
  })

  it('sends distinct options and shows no message', async () => {
    const { container } = render(PollCreateForm)
    await submitWith(container, 'Ja\nNein')
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(sent).toHaveLength(1)
  })

  it('drops the message once the list is fixed and submitted again', async () => {
    const { container } = render(PollCreateForm)
    await submitWith(container, 'Ja\nJa')
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
    await submitWith(container, 'Ja\nNein')
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(sent).toHaveLength(1)
  })
})
