<script lang="ts">
  import { onMount } from 'svelte'

  onMount(() => {
    if (window.parent !== window) {
      // The embedding page is on the host this frame was loaded from. The process env names only ONE
      // customer host, so it cannot address the parent on any other.
      window.parent.postMessage({ type: 'helios_auth', status: 'ok' }, window.location.origin)
      return
    }
    const segments = window.location.pathname.split('/')
    const id = segments[2] ?? ''
    window.location.replace(id ? `/elections/${id}` : '/elections')
  })
</script>

<!-- Intentionally blank — this page is only ever rendered inside a hidden iframe -->
