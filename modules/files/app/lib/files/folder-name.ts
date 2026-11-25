// Why a folder name typed into the "Neuer Ordner" dialog is refused, or null when it may be sent.
//
// The files API already refuses a name that would leave the folder it is created in (a path separator, a dot
// segment, a control character), and creates nothing. Without this check the dialog sent the name anyway and
// closed with no word, so the person saw no folder and no reason. The dialog asks here first and shows the reason.
// The API stays the authority; this mirrors its refusals so the person is told before the round trip.

export type FolderNameProblem = 'empty' | 'separator' | 'dots' | 'characters'

export function folderNameProblem(name: string): FolderNameProblem | null {
  const trimmed = name.trim()
  if (!trimmed) return 'empty'
  if (/[/\\]/.test(name)) return 'separator'
  // The API treats a segment of only dots (a space around them does not help) as a way up out of the folder.
  if (trimmed === '.' || trimmed === '..') return 'dots'
  // oxlint-disable-next-line no-control-regex -- the pattern exists to REFUSE control characters
  if (/[\u0000-\u001f\u007f]/.test(name)) return 'characters'
  return null
}
