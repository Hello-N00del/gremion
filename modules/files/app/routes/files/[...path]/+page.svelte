<script lang="ts">
  import PageTitle from '$lib/components/PageTitle.svelte'
  import type { PageData } from './$types'
  import { page } from '$app/stores'
  import { Role } from '$lib/auth'
  import FileBrowser from '$lib/components/files/FileBrowser.svelte'

  let { data }: { data: PageData } = $props()

  const currentPath = $derived($page.params.path ?? '')
  const readonly = $derived(data.user?.roles?.length === 1 && data.user.roles[0] === Role.Guest)
</script>

<PageTitle title="Dateien" />

<div class="space-y-4">
  <h1 class="text-2xl font-bold">Dateien</h1>
  <FileBrowser rootPath={currentPath} {readonly} />
</div>
