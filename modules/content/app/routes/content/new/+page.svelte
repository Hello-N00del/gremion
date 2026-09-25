<script lang="ts">
  // PLAIN create form — title only; the editor handles everything else.
  import PageTitle from '$lib/components/PageTitle.svelte'
  import { enhance } from '$app/forms'
  import type { ActionData } from './$types'

  let { form }: { form: ActionData } = $props()
  let submitting = $state(false)
</script>

<PageTitle title="Neuer Inhalt" />

<div class="wrap">
  <a class="back" href="/content">← Inhalte</a>
  <h1>Neuer Inhalt</h1>

  <form
    method="POST"
    action="?/create"
    use:enhance={() => {
      submitting = true
      return async ({ update }) => {
        await update()
        submitting = false
      }
    }}
  >
    <label for="title">Titel</label>
    <input
      id="title"
      name="title"
      type="text"
      placeholder="Titel des Inhalts"
      value={form?.title ?? ''}
      required
    />
    {#if form?.error}
      <p class="err" role="alert">{form.error}</p>
    {/if}
    <button class="btn" type="submit" disabled={submitting}>
      {submitting ? 'Wird angelegt…' : 'Anlegen & bearbeiten'}
    </button>
  </form>
</div>

<style>
  .wrap { max-width: 520px; }
  .back { font-size: 13px; color: var(--ink-muted, #666); text-decoration: none; }
  .back:hover { text-decoration: underline; }
  h1 { font-size: 24px; font-weight: 600; margin: 8px 0 20px; }
  form { display: flex; flex-direction: column; gap: 8px; }
  label { font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--ink-muted, #666); }
  input { padding: 9px 11px; border: 1px solid var(--border, #ccc); border-radius: 6px; font-size: 14px; background: var(--surface, #fff); color: inherit; }
  .err { color: var(--rust-ink, #b00); font-size: 13px; }
  .btn { margin-top: 8px; align-self: flex-start; padding: 8px 16px; border: 1px solid var(--border, #ccc); border-radius: 6px; font-size: 13px; background: var(--surface-2, #f5f5f5); cursor: pointer; color: inherit; }
  .btn:disabled { opacity: 0.6; cursor: default; }
</style>
