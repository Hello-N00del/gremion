<script lang="ts">
  // The small line under the product name: the organisation's short name and
  // the semester ("MS · WiSe 26/27"). The column is narrow (about 110 px at the
  // default size) and the short name may be 20 characters, so the two do not
  // always fit side by side. They sit on ONE line when they do; otherwise the
  // semester drops to its own second line, whole, and only a short name wider
  // than the whole line is cut with an ellipsis (its full text stays in the
  // title). The dot between them is drawn by the semester's ::before at the
  // left edge of its padding; the row is pulled left by that padding and the
  // outer box clips it, so a semester that starts a new line shows no dot.
  let { orgShort, term }: { orgShort: string; term: string } = $props()
</script>

<div class="brand-line">
  <div class="bl-row">
    <span class="bl-org" title={orgShort}>{orgShort}</span>
    <span class="bl-term">{term}</span>
  </div>
</div>

<style>
  .brand-line {
    --sep: 1.4em;
    overflow: hidden;
    font-family: var(--font-mono);
    font-size: 9.5px;
    letter-spacing: 0.14em;
    color: var(--ink-muted);
    text-transform: uppercase;
  }
  .bl-row {
    display: flex;
    flex-wrap: wrap;
    margin-left: calc(var(--sep) * -1);
  }
  .bl-org,
  .bl-term {
    padding-left: var(--sep);
    white-space: nowrap;
  }
  .bl-org {
    min-width: 0;
    max-width: 100%;
    box-sizing: border-box;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .bl-term {
    position: relative;
    flex-shrink: 0;
  }
  .bl-term::before {
    content: '·';
    position: absolute;
    left: 0.45em;
  }
</style>
