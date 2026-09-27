<script lang="ts">
  import PageTitle from '$lib/components/PageTitle.svelte'
  import type { PageData, LayoutData, ActionData } from './$types'
  import { t } from '$lib/i18n'
  import SettingsBody from './SettingsBody.svelte'

  let { data, form }: { data: PageData & LayoutData; form?: ActionData } = $props()

  // TASK-062: a failed language switch (action `locale`) re-renders /settings
  // itself, not the /settings/darstellung deep link it was posted from. Open
  // the Darstellung section so the switch's role="alert" reaches the person.
  const activeSection = $derived(form?.localeError ? 'darstellung' : undefined)
</script>

<PageTitle title={$t('settings.title')} />

<SettingsBody {data} {activeSection} />
