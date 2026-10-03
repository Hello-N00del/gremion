<script lang="ts">
  import PageTitle from '$lib/components/PageTitle.svelte'
  import type { PageData } from './$types'
  import { Role } from '$lib/auth'
  import FileBrowser from '$lib/components/files/FileBrowser.svelte'
  import FileWorkspaceSidebar from '$lib/components/files/FileWorkspaceSidebar.svelte'
  import Icon from '$lib/components/ui/Icon.svelte'

  let { data }: { data: PageData } = $props()

  const readonly = $derived(data.user?.roles?.length === 1 && data.user.roles[0] === Role.Guest)

  let workspaces = $derived(data.workspaces ?? [])

  // Active workspace drives the FileBrowser rootPath. '' = the Nextcloud root
  // ("Alle Dateien"). Selecting a committee scopes into its provisioned folder,
  // which Nextcloud exposes under the committee name. Tags are presentational
  // filters (Nextcloud systemtags have no WebDAV-path equivalent here) so they
  // don't change the path — they remain a forward-looking affordance.
  // initialWorkspace (#157) is the loader-resolved label for a `?ou=` deep-link
  // from the Gremien detail panel; absent a deep-link it is '' ("Alle Dateien").
  let activeWorkspace = $state(data.initialWorkspace ?? '')
</script>

<PageTitle title="Sitzungsunterlagen" />

<div class="files-page">
  <div class="page-head">
    <div>
      <div class="eyebrow">Dokumente · Nextcloud</div>
      <!-- Page title is "Sitzungsunterlagen" (v4); the sidebar nav stays "Dateien". -->
      <h1 class="page-title">Sitzungsunterlagen</h1>
    </div>
  </div>

  <!-- Collabora handoff: editing happens in the real Collabora Online editor
       (opened from the file row's "Öffnen" action → /files/edit/...). This card
       documents that the editing surface is an external module. -->
  <div class="handoff-card">
    <div class="handoff-icon"><Icon name="edit" size={26} /></div>
    <div>
      <div class="handoff-title">Bearbeitung in Collabora Online</div>
      <div class="handoff-sub">
        .odt · .docx · .xlsx · .ods · .odp werden direkt in Nextcloud geöffnet. Mehrere Mitglieder
        können gleichzeitig schreiben; Änderungen werden versioniert.
      </div>
    </div>
    <span class="view-restriction"><Icon name="external" size={12} /> Externes Modul</span>
  </div>

  <div class="files-body">
    <FileWorkspaceSidebar
      {workspaces}
      active={activeWorkspace}
      onSelect={(id) => (activeWorkspace = id)}
    />
    <div class="files-browser">
      <FileBrowser rootPath={activeWorkspace} {readonly} />
    </div>
  </div>
</div>

<style>
  /* page-head + handoff-card ported from the bundle (web/tokens.css). Generic
     primitives come from app.css; values resolve to design tokens so .dark
     auto-switches. */
  .files-page {
    display: flex;
    flex-direction: column;
    gap: 18px;
  }
  .files-body {
    display: grid;
    grid-template-columns: 240px 1fr;
    gap: 20px;
    align-items: start;
  }
  .files-browser {
    min-width: 0;
  }
  @media (max-width: 760px) {
    .files-body {
      grid-template-columns: 1fr;
    }
  }
  .page-head {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    gap: 20px;
  }
  .page-title {
    font-family: var(--font-display);
    font-size: 30px;
    font-weight: 500;
    letter-spacing: -0.015em;
    line-height: 1.1;
  }

  .handoff-card {
    background: linear-gradient(135deg, var(--surface) 0%, var(--surface-2) 100%);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    padding: 20px 22px;
    display: grid;
    grid-template-columns: 56px 1fr auto;
    gap: 18px;
    align-items: center;
  }
  @media (max-width: 640px) {
    .handoff-card {
      grid-template-columns: 56px 1fr;
    }
    .handoff-card .view-restriction {
      grid-column: 2;
      justify-self: start;
    }
  }
  .handoff-icon {
    width: 56px;
    height: 56px;
    border-radius: var(--r-md);
    background: var(--ink);
    color: var(--paper);
    display: grid;
    place-items: center;
  }
  :global(.dark) .handoff-icon {
    color: #0e0f10;
  }
  .handoff-title {
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 600;
  }
  .handoff-sub {
    font-size: 12.5px;
    color: var(--ink-muted);
    margin-top: 4px;
    max-width: 520px;
    line-height: 1.5;
  }
  .view-restriction {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.06em;
    color: var(--ink-muted);
    padding: 4px 9px;
    border-radius: 100px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    text-transform: uppercase;
    white-space: nowrap;
  }
</style>
