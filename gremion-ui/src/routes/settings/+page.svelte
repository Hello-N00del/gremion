<script lang="ts">
  import PageTitle from '$lib/components/PageTitle.svelte'
  import type { PageData, LayoutData } from './$types'
  import { t } from '$lib/i18n'
  import SettingsBody from './SettingsBody.svelte'

  let { data }: { data: PageData & LayoutData } = $props()
</script>

<PageTitle title={$t('settings.title')} />

<SettingsBody {data} />
