export interface DragPosition {
  /** Distance from right edge of viewport in px */
  x: number
  /** Distance from bottom edge of viewport in px */
  y: number
}

interface DraggableOptions {
  position: DragPosition
  onMove: (pos: DragPosition) => void
  /** Margin from viewport edges in px (default 8) */
  margin?: number
  /** When false, disables drag handling (default true) */
  enabled?: boolean
}

/**
 * Clamps a bottom-right position so the element stays within the viewport.
 * x = distance from right, y = distance from bottom.
 */
export function clampPosition(
  pos: DragPosition,
  elementWidth: number,
  elementHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  margin = 8,
): DragPosition {
  const maxX = viewportWidth - elementWidth - margin
  const maxY = viewportHeight - elementHeight - margin
  return {
    x: Math.min(Math.max(pos.x, margin), maxX),
    y: Math.min(Math.max(pos.y, margin), maxY),
  }
}

/**
 * Svelte action: use:draggable={{ position, onMove }}
 * Moves element with pointer events. Position is bottom-right anchored.
 */
export function draggable(node: HTMLElement, options: DraggableOptions) {
  let currentOptions = options
  let isDragging = false
  let startPointerX = 0
  let startPointerY = 0
  let startPosX = currentOptions.position.x
  let startPosY = currentOptions.position.y

  // While dragging, suppress pointer events on any nested iframes so the iframe's
  // document doesn't steal events and the drag stays reliable even over video content.
  function setIframePointerEvents(value: string) {
    node.querySelectorAll('iframe').forEach((f) => {
      ;(f as HTMLElement).style.pointerEvents = value
    })
  }

  function stopDrag() {
    if (!isDragging) return
    isDragging = false
    setIframePointerEvents('')
  }

  function onPointerDown(e: PointerEvent) {
    if (!(currentOptions.enabled ?? true)) return
    // Let interactive elements (buttons, links) receive their own click events.
    if ((e.target as HTMLElement).closest('button, a, input, select, textarea')) return
    isDragging = true
    startPointerX = e.clientX
    startPointerY = e.clientY
    startPosX = currentOptions.position.x
    startPosY = currentOptions.position.y
    node.setPointerCapture(e.pointerId)
    setIframePointerEvents('none')
    e.preventDefault()
  }

  function onPointerMove(e: PointerEvent) {
    if (!isDragging) return
    const dx = e.clientX - startPointerX
    const dy = e.clientY - startPointerY
    const margin = currentOptions.margin ?? 8
    const newPos = clampPosition(
      { x: startPosX - dx, y: startPosY - dy },
      node.offsetWidth,
      node.offsetHeight,
      window.innerWidth,
      window.innerHeight,
      margin,
    )
    currentOptions.onMove(newPos)
  }

  node.addEventListener('pointerdown', onPointerDown)
  node.addEventListener('pointermove', onPointerMove)
  node.addEventListener('pointerup', stopDrag)
  // lostpointercapture fires when the browser releases pointer capture (e.g. pointer
  // leaves the window and the button is released outside). Without this the drag state
  // stays active and pointer-events:none persists on the iframe until the next click.
  node.addEventListener('lostpointercapture', stopDrag)

  return {
    update(newOptions: DraggableOptions) {
      currentOptions = newOptions
    },
    destroy() {
      node.removeEventListener('pointerdown', onPointerDown)
      node.removeEventListener('pointermove', onPointerMove)
      node.removeEventListener('pointerup', stopDrag)
      node.removeEventListener('lostpointercapture', stopDrag)
    },
  }
}
