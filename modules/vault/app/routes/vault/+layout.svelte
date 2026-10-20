<script lang="ts">
  // Vault module CSS (#405 design v11) — route-level import so Vite
  // code-splits it with the vault chunk (handover.css / finance.css pattern).
  import './vault.css'

  let { children } = $props()
</script>

{@render children()}
