<script lang="ts">
  import type { PageData } from './$types'
  let { data }: { data: PageData } = $props()
</script>

<div class="p-6 max-w-3xl mx-auto">
  <!-- eslint-disable-next-line svelte/no-at-html-tags -->
  {@html data.html}
</div>
