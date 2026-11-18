<script lang="ts">
  import PageTitle from '$lib/components/PageTitle.svelte'
  import { enhance } from '$app/forms'
  import type { ActionData, PageData } from './$types'
  import { lang, t } from '$lib/i18n'

  let { data, form }: { data: PageData; form: ActionData } = $props()
  let kind = $state<'council' | 'committee' | 'group'>('committee')
  // WCAG 3.1.2: the placeholders are catalogue text in the person's language, but what the person types is
  // their own text (a committee name, usually German), so each field is marked English only while it is
  // empty and shows its placeholder; a lang on a filled field would also switch the spell checker.
  let nameBlank = $state(true)
  let descriptionBlank = $state(true)
</script>

<PageTitle title={$t('members.new.title')} />

<div class="max-w-2xl mx-auto">
  <h1 class="text-2xl font-semibold mb-6" lang={$lang}>{$t('members.new.title')}</h1>

  {#if form?.error}
    <p class="text-sm text-rust mb-4">{form.error}</p>
  {/if}

  <form method="POST" use:enhance class="space-y-4">
    <div>
      <label for="name" class="block text-sm font-medium mb-1">
        <span lang={$lang}>{$t('members.new.name')}</span> <span class="text-rust">*</span>
      </label>
      <input
        id="name"
        name="name"
        type="text"
        required
        class="w-full rounded-md border border-border-strong bg-paper px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-accent"
        lang={nameBlank ? $lang : undefined}
        oninput={(e) => (nameBlank = e.currentTarget.value === '')}
        placeholder={$t('members.new.name.placeholder')}
      />
    </div>

    <div>
      <label for="description" class="block text-sm font-medium mb-1" lang={$lang}>{$t('members.new.description')}</label>
      <textarea
        id="description"
        name="description"
        rows="3"
        class="w-full rounded-md border border-border-strong bg-paper px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-accent"
        lang={descriptionBlank ? $lang : undefined}
        oninput={(e) => (descriptionBlank = e.currentTarget.value === '')}
        placeholder={$t('members.new.description.placeholder')}
      ></textarea>
    </div>

    <label class="block space-y-1">
      <span class="text-xs font-medium">Art</span>
      <select name="kind" bind:value={kind} class="w-full rounded-md border border-border-strong bg-paper px-3 py-2 text-sm">
        <option value="committee">Gremium</option>
        <option value="council">Rat</option>
        <option value="group">Gruppe</option>
      </select>
    </label>

    {#if kind !== 'council'}
      <label class="block space-y-1">
        <span class="text-xs font-medium">Übergeordnete Einheit (optional)</span>
        <select name="parentId" class="w-full rounded-md border border-border-strong bg-paper px-3 py-2 text-sm">
          <option value="">— keine —</option>
          {#each data.parents as p (p.id)}
            <option value={p.id}>{p.name}</option>
          {/each}
        </select>
      </label>
    {/if}

    <label class="flex items-center gap-2 text-sm">
      <input type="checkbox" name="wantsMatrixRoom" aria-label="Matrix-Raum anlegen" checked />
      Matrix-Raum anlegen
    </label>
    <label class="flex items-center gap-2 text-sm">
      <input type="checkbox" name="wantsNextcloudFolder" aria-label="Nextcloud-Ordner anlegen" checked />
      Nextcloud-Ordner anlegen
    </label>

    <div class="flex gap-3 pt-2">
      <button
        type="submit"
        class="rounded-md bg-accent px-4 py-2 text-sm font-medium text-paper hover:bg-accent/90"
      >
        <span lang={$lang}>{$t('members.new.submit')}</span>
      </button>
    </div>
  </form>
</div>
