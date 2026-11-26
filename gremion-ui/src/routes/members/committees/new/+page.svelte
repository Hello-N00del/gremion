<script lang="ts">
  import PageTitle from '$lib/components/PageTitle.svelte'
  import { enhance } from '$app/forms'
  import type { ActionData, PageData } from './$types'
  import { lang, t } from '$lib/i18n'
  import { untrack } from 'svelte'

  let { data, form }: { data: PageData; form: ActionData } = $props()
  // The kinds are the customer's catalogue; the parent list follows the chosen kind's own allowedParentKinds,
  // the rule the server applies on submit (validateCreatePlacement).
  const kinds = $derived(data.kinds ?? [])
  let kind = $state(untrack(() => (data.kinds ?? []).find((k) => k.key === 'committee')?.key ?? data.kinds?.[0]?.key ?? ''))
  let parentId = $state('')
  const kindDef = $derived(kinds.find((k) => k.key === kind))
  const parentOptions = $derived((data.parents ?? []).filter((p) => kindDef?.allowedParentKinds.includes(p.kind)))
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

    <div class="space-y-1">
      <label for="kind" class="block text-xs font-medium">Art</label>
      <select
        id="kind"
        name="kind"
        bind:value={kind}
        onchange={() => (parentId = '')}
        class="w-full rounded-md border border-border-strong bg-paper px-3 py-2 text-sm"
      >
        {#each kinds as k (k.key)}
          <option value={k.key}>{k.label}</option>
        {/each}
      </select>
    </div>

    {#if kindDef && kindDef.allowedParentKinds.length > 0}
      <div class="space-y-1">
        <label for="parentId" class="block text-xs font-medium">
          Übergeordnete Einheit{kindDef.canBeRoot ? ' (optional)' : ''}
        </label>
        <select
          id="parentId"
          name="parentId"
          bind:value={parentId}
          required={!kindDef.canBeRoot}
          class="w-full rounded-md border border-border-strong bg-paper px-3 py-2 text-sm"
        >
          {#if kindDef.canBeRoot}
            <option value="">— keine —</option>
          {:else}
            <option value="" disabled>— bitte wählen —</option>
          {/if}
          {#each parentOptions as p (p.id)}
            <option value={p.id}>{p.name}</option>
          {/each}
        </select>
      </div>
    {/if}

    <label class="flex items-center gap-2 text-sm">
      <input type="checkbox" name="wantsMatrixRoom" aria-label="Chatraum anlegen" checked />
      Chatraum anlegen
    </label>
    <label class="flex items-center gap-2 text-sm">
      <input type="checkbox" name="wantsNextcloudFolder" aria-label="Dateiordner anlegen" checked />
      Dateiordner anlegen
    </label>

    <div class="flex gap-3 pt-2">
      <button
        type="submit"
        lang={$lang}
        aria-label={$t('members.new.submit')}
        class="rounded-md bg-accent px-4 py-2 text-sm font-medium text-paper hover:bg-accent/90"
      >
        {$t('members.new.submit')}
      </button>
    </div>
  </form>
</div>
