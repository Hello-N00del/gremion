import { getContext, setContext } from 'svelte'

const DIALOG_CONTEXT_KEY = Symbol('dialog')

export interface DialogContext {
  /** The id wired to aria-labelledby on the dialog container; DialogTitle sets it on its heading. */
  titleId: string
  /** Called by DialogTitle on mount so the container knows a title exists and can set aria-labelledby. */
  registerTitle: () => void
}

export function setDialogContext(ctx: DialogContext): DialogContext {
  return setContext(DIALOG_CONTEXT_KEY, ctx)
}

/** Returns the dialog context, or undefined when DialogTitle is used outside a Dialog. */
export function getDialogContext(): DialogContext | undefined {
  return getContext<DialogContext | undefined>(DIALOG_CONTEXT_KEY)
}
