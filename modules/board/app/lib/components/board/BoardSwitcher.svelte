<script lang="ts">
  import { deriveHue } from '$lib/governance/committee-color'
  import { boardChipLabel, type SwitcherBoard } from './board-label'

  // The chips of the board bar: one per board, the open one marked. Boards that share a title
  // carry their committee's name, so no two chips read the same (see board-label.ts). The chip
  // styles come from the tasks route's deck.css.
  let {
    boards,
    selectedId,
    onselect,
  }: {
    boards: readonly SwitcherBoard[]
    selectedId: string | null
    onselect: (boardId: string) => void
  } = $props()
</script>

{#each boards as b (b.id)}
  <button
    type="button"
    class="board-chip"
    class:on={b.id === selectedId}
    style="--c-hue: {deriveHue(b.org_unit_id)}"
    onclick={() => onselect(b.id)}
  >
    <span class="swatch"></span>{boardChipLabel(b, boards)}
  </button>
{/each}
