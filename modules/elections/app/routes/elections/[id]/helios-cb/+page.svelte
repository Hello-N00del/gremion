<script lang="ts">
  import { onMount } from 'svelte'
  import { env } from '$env/dynamic/public'

  onMount(() => {
    if (window.parent !== window) {
      window.parent.postMessage(
        { type: 'helios_auth', status: 'ok' },
        env.PUBLIC_BASE_URL ?? window.location.origin,
      )
      return
    }
    const segments = window.location.pathname.split('/')
    const id = segments[2] ?? ''
    window.location.replace(id ? `/elections/${id}` : '/elections')
  })
</script>

<!-- Intentionally blank — this page is only ever rendered inside a hidden iframe -->
