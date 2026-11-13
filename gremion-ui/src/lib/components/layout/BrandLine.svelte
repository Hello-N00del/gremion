<script lang="ts">
  // The small line under the product name: the organisation's short name and
  // the semester ("MS · WiSe 26/27"). One line. The short name may be up to 20
  // characters and the column is narrow, so when the two do not fit the SHORT
  // NAME is cut with an ellipsis (its full text stays in the title) and the
  // semester always stays whole: it is the part that changes, and it is short.
  let { orgShort, term }: { orgShort: string; term: string } = $props()
</script>

<div class="brand-line">
  <span class="org" title={orgShort}>{orgShort}</span>
  <span class="sep" aria-hidden="true">·</span>
  <span class="term">{term}</span>
</div>

<style>
  .brand-line {
    display: flex;
    align-items: baseline;
    gap: 0.6em;
    min-width: 0;
    font-family: var(--font-mono);
    font-size: 9.5px;
    letter-spacing: 0.14em;
    color: var(--ink-muted);
    text-transform: uppercase;
    white-space: nowrap;
  }
  .org {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sep,
  .term {
    flex-shrink: 0;
  }
</style>
