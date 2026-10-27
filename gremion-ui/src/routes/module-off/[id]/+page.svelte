<script lang="ts">
  import { page } from '$app/state'
  import PageTitle from '$lib/components/PageTitle.svelte'
  import ModuleOffNotice from '$lib/components/ModuleOffNotice.svelte'

  // Served (status 403) by hooks.server.ts in place of a disabled module's page; renders inside the root
  // layout, so the app shell comes from +layout.svelte.
  const roles = $derived((page.data.session as { user?: { roles?: string[] } } | null)?.user?.roles ?? [])
</script>

<PageTitle title="Modul nicht aktiv" />
<ModuleOffNotice moduleId={page.params.id ?? ''} isItAdmin={roles.includes('it-admin')} />
