<script lang="ts">
  import PageTitle from '$lib/components/PageTitle.svelte'
  import type { PageData } from './$types'
  import { page } from '$app/stores'
  import { goto } from '$app/navigation'
  import { toast } from 'svelte-sonner'
  import { onMount } from 'svelte'
  import { Role } from '$lib/auth'
  import FileBrowser from '$lib/components/files/FileBrowser.svelte'

  let { data }: { data: PageData } = $props()

  const groupName = $page.params.group ?? ''

  onMount(() => {
    const user = data.user
    if (!user) return
    const hasAccess =
      (user.groups ?? []).includes(groupName) ||
      user.roles.includes(Role.CouncilAdmin) ||
      user.roles.includes(Role.ITAdmin)
    if (!hasAccess) {
      toast.error('Kein Zugriff auf diesen Gruppenordner')
      goto('/files')
    }
  })
</script>

<PageTitle title={`${groupName} – Dateien`} />

<div class="space-y-4">
  <h1 class="text-2xl font-bold">{groupName}</h1>
  <FileBrowser rootPath="__groupfolders/{groupName}" readonly={false} />
</div>
