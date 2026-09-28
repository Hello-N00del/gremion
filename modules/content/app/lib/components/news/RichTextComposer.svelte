<script lang="ts" module>
  import DOMPurify from 'isomorphic-dompurify'

  // Client-side allowlist mirroring the server's sanitizeRichHtml
  // (src/lib/server/security/html-sanitize.ts). The PATCH endpoint and
  // news-db both re-sanitize on save, so this pass is for clean storage /
  // UX — never the sole line of defence. Kept in sync deliberately: the
  // composer only ever produces the formatting it offers below.
  const COMPOSER_HTML_CONFIG = {
    ALLOWED_TAGS: [
      'p', 'br', 'strong', 'em', 'u', 'ul', 'ol', 'li',
      'h2', 'h3', 'a', 'blockquote', 'span',
    ],
    ALLOWED_ATTR: ['href', 'title'],
    ALLOW_DATA_ATTR: false,
  }

  const FORBIDDEN_URI_SCHEMES = /^\s*(?:data|javascript|vbscript):/i

  /** Sanitize composer output before it leaves the component. */
  export function sanitizeComposerHtml(rawHtml: string): string {
    return DOMPurify.sanitize(rawHtml, COMPOSER_HTML_CONFIG)
  }
</script>

<script lang="ts">
  import { t } from '$lib/i18n'
  import Icon from '$lib/components/ui/Icon.svelte'

  interface Props {
    /** Bound HTML value (sanitized on every edit). */
    value: string
    /** Disable all editing affordances. */
    disabled?: boolean
    /** Accessible label for the editing surface. */
    ariaLabel?: string
  }

  let { value = $bindable(''), disabled = false, ariaLabel }: Props = $props()

  let editor = $state<HTMLDivElement | null>(null)
  let linkRowOpen = $state(false)
  let linkUrl = $state('')
  // Stored selection range so the link is applied to the text the user had
  // selected before focus moved to the inline URL input.
  let savedRange: Range | null = null

  // Push external value changes into the contenteditable surface without
  // clobbering the caret while the user is actively typing in it.
  $effect(() => {
    const html = value
    if (editor && document.activeElement !== editor && editor.innerHTML !== html) {
      // eslint-disable-next-line svelte/no-dom-manipulating -- `editor` is an empty contenteditable surface Svelte never renders children into; its content is driven imperatively (this effect pushes the external value in, syncFromDom sanitizes edits back out).
      editor.innerHTML = html
    }
  })

  function syncFromDom() {
    if (!editor) return
    value = sanitizeComposerHtml(editor.innerHTML)
  }

  function exec(command: string, arg?: string) {
    if (disabled) return
    editor?.focus()
    // execCommand is deprecated but remains the only cross-browser way to
    // drive a contenteditable surface without pulling in a heavy editor
    // dependency — adequate for a lightweight in-repo composer.
    document.execCommand(command, false, arg)
    syncFromDom()
  }

  function openLinkRow() {
    if (disabled) return
    const sel = window.getSelection()
    savedRange = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null
    linkUrl = ''
    linkRowOpen = true
  }

  function applyLink() {
    const url = linkUrl.trim()
    linkRowOpen = false
    if (!url || FORBIDDEN_URI_SCHEMES.test(url)) return
    // Restore the selection captured before the input took focus.
    if (savedRange) {
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(savedRange)
    }
    exec('createLink', url)
  }

  interface ToolButton {
    label: string
    title: string
    action: () => void
    icon?: string
  }

  const tools = $derived<ToolButton[]>([
    { label: 'B', title: $t('news.composer.bold'), action: () => exec('bold') },
    { label: 'I', title: $t('news.composer.italic'), action: () => exec('italic') },
    { label: 'U', title: $t('news.composer.underline'), action: () => exec('underline') },
    { label: 'H2', title: $t('news.composer.heading'), action: () => exec('formatBlock', '<h2>') },
    { label: '•', title: $t('news.composer.bulletList'), action: () => exec('insertUnorderedList') },
    { label: '1.', title: $t('news.composer.numberedList'), action: () => exec('insertOrderedList') },
    { label: '“”', title: $t('news.composer.quote'), action: () => exec('formatBlock', '<blockquote>') },
    { label: '', title: $t('news.composer.link'), action: openLinkRow, icon: 'link' },
  ])
</script>

<div class="composer" class:is-disabled={disabled}>
  <div class="toolbar" role="toolbar" aria-label={$t('news.composer.toolbar')}>
    {#each tools as tool (tool.title)}
      <button
        type="button"
        class="tool-btn"
        class:tool-ico={!!tool.icon}
        title={tool.title}
        aria-label={tool.title}
        {disabled}
        onmousedown={(e) => e.preventDefault()}
        onclick={tool.action}
      >
        {#if tool.icon}
          <Icon name={tool.icon} size={14} />
        {:else}
          {tool.label}
        {/if}
      </button>
    {/each}
  </div>

  {#if linkRowOpen}
    <div class="link-row">
      <input
        class="link-input"
        type="url"
        placeholder="https://…"
        aria-label={$t('news.composer.linkPrompt')}
        bind:value={linkUrl}
        onkeydown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            applyLink()
          } else if (e.key === 'Escape') {
            linkRowOpen = false
          }
        }}
      />
      <button type="button" class="tool-btn" onclick={applyLink}>{$t('news.composer.linkApply')}</button>
      <button type="button" class="tool-btn" onclick={() => (linkRowOpen = false)}>
        {$t('news.composer.linkCancel')}
      </button>
    </div>
  {/if}

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    bind:this={editor}
    class="surface"
    contenteditable={!disabled}
    role="textbox"
    tabindex="0"
    aria-multiline="true"
    aria-label={ariaLabel ?? $t('news.composer.body')}
    aria-disabled={disabled}
    data-placeholder={$t('news.composer.placeholder')}
    oninput={syncFromDom}
    onblur={syncFromDom}
  ></div>
</div>

<style>
  .composer {
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    background: var(--surface);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 2px;
    padding: 6px;
    border-bottom: 1px solid var(--border);
    background: var(--surface-2);
  }
  .tool-btn {
    position: relative;
    min-width: 30px;
    height: 28px;
    padding: 0 8px;
    border: 1px solid transparent;
    border-radius: var(--r-sm);
    background: none;
    color: var(--ink);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: background var(--d-fast), border-color var(--d-fast);
  }
  /* Transparent hit layer restoring the 44px touch target over the compact
     30x28px visible button — mirrors the canonical icon-button ::after in
     app.css. Applies to every toolbar button (link tool + link apply/cancel). */
  .tool-btn::after {
    content: '';
    position: absolute;
    inset: calc((28px - var(--touch-target-min)) / 2) calc((30px - var(--touch-target-min)) / 2);
  }
  .tool-btn:hover {
    background: var(--surface);
    border-color: var(--border);
  }
  .tool-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  /* Local tint hook for the icon-only link tool button (renamed so it does
     not collide with the canonical app.css icon-button metrics). */
  .tool-ico {
    color: var(--ink-muted);
  }
  .link-row {
    display: flex;
    gap: 6px;
    padding: 6px;
    border-bottom: 1px solid var(--border);
    background: var(--surface-2);
  }
  .link-input {
    flex: 1;
    height: 28px;
    padding: 0 8px;
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    background: var(--surface);
    color: var(--ink);
    font-size: 13px;
  }
  .link-input:focus {
    outline: none;
    border-color: var(--border-strong);
  }
  .surface {
    flex: 1;
    min-height: 220px;
    padding: 14px 16px;
    font-size: 14px;
    line-height: 1.6;
    color: var(--ink);
    overflow-y: auto;
    outline: none;
  }
  .surface:focus {
    box-shadow: inset 0 0 0 2px var(--accent-soft, var(--border-strong));
  }
  .surface:empty::before {
    content: attr(data-placeholder);
    color: var(--ink-faint);
    pointer-events: none;
  }
  .surface :global(h2) {
    font-size: 18px;
    font-weight: 600;
    margin: 0.6em 0 0.3em;
  }
  .surface :global(ul),
  .surface :global(ol) {
    padding-left: 1.4em;
    margin: 0.4em 0;
  }
  .surface :global(blockquote) {
    border-left: 3px solid var(--border-strong);
    margin: 0.5em 0;
    padding-left: 12px;
    color: var(--ink-muted);
  }
  .surface :global(a) {
    color: var(--rust, var(--ink));
    text-decoration: underline;
  }
  .is-disabled .surface {
    background: var(--surface-2);
    color: var(--ink-muted);
  }
</style>
