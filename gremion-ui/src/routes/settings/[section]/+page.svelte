<script lang="ts">
  import PageTitle from '$lib/components/PageTitle.svelte'
  import type { PageData } from './$types'
  import { t } from '$lib/i18n'
  import SettingsBody from '../SettingsBody.svelte'

  // #167: the deep-link alias route renders the SAME unified settings body with
  // the active section pre-selected from the validated `activeSection` param.
  // PageData already merges the settings layout load (config/isITAdmin/
  // loeschkonzept/user/accountUrl) with this route's `activeSection`.
  let { data }: { data: PageData } = $props()
</script>

<PageTitle title={$t('settings.title')} />

<SettingsBody {data} activeSection={data.activeSection} />
