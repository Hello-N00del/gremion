<script lang="ts">
  import { enhance } from '$app/forms'
  import type { ActionData, PageData } from './$types'
  import { t } from '$lib/i18n'

  let { data, form }: { data: PageData; form: ActionData } = $props()
  let kind = $state<'council' | 'committee' | 'group'>('committee')
</script>

<div class="max-w-2xl mx-auto">
  <h1 class="text-2xl font-semibold mb-6">{$t('members.new.title')}</h1>

  {#if form?.error}
    <p class="text-sm text-rust mb-4">{form.error}</p>
  {/if}

  <form method="POST" use:enhance class="space-y-4">
    <div>
      <label for="name" class="block text-sm font-medium mb-1">
        {$t('members.new.name')} <span class="text-rust">*</span>
      </label>
      <input
        id="name"
        name="name"
        type="text"
        required
        class="w-full rounded-md border border-border-strong bg-paper px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-accent"
        placeholder={$t('members.new.name.placeholder')}
      />
    </div>

    <div>
      <label for="description" class="block text-sm font-medium mb-1">{$t('members.new.description')}</label>
      <textarea
        id="description"
        name="description"
        rows="3"
        class="w-full rounded-md border border-border-strong bg-paper px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-accent"
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
      <input type="checkbox" name="wantsMatrixRoom" checked />
      Matrix-Raum anlegen
    </label>
    <label class="flex items-center gap-2 text-sm">
      <input type="checkbox" name="wantsNextcloudFolder" checked />
      Nextcloud-Ordner anlegen
    </label>

    <div class="flex gap-3 pt-2">
      <button
        type="submit"
        class="rounded-md bg-accent px-4 py-2 text-sm font-medium text-paper hover:bg-accent/90"
      >
        {$t('members.new.submit')}
      </button>
    </div>
  </form>
</div>
