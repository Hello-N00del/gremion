<script lang="ts">
  // The one mount of the elections scope notice (PRD-ELE-002): every page below
  // /elections shows it, permanently, for members and admins alike.
  import ElectionsNotice from '$lib/components/elections-notice/ElectionsNotice.svelte'

  let { children } = $props()
</script>

<ElectionsNotice />
{@render children()}
