/** An item as the band shows it. */
export type Finding = {
  /** What is wrong, in one plain sentence. */
  what: string
  /** What shows it: the command that was run and what it printed, or the model's own words. */
  evidence: string
  /** What goes wrong if the assistant keeps going as it is. */
  cost: string
}

/** Where an item stands: closed by a command that passes (fixed), or by the model telling the person (told, refuted). */
export type Status = 'open' | 'fixed' | 'refuted' | 'told'

/** One item put to the model, numbered, tracked until it is settled. */
export type Issue = {
  id: number
  /** When it was raised, epoch ms. */
  at: number
  /** Which check raised it: the verifier (a command's output contradicted the model) or a rule in code. */
  from: 'verify' | 'rule'
  /** What is actually so, in one plain sentence; never how to fix it. */
  what: string
  /** The model's own words the item is about. */
  quote: string
  /** The command the verifier ran, or for a rule what would settle it (`Read <path>`). */
  probe: string
  /** The verifier's: what the command printed, which contradicts the quote. */
  saw?: string
  /** The verifier's: a shell command that exits 0 exactly when the claim holds; it settles the item. */
  recheck?: string
  /** What goes wrong if the assistant keeps going as it is. */
  cost: string
  status: Status
  /** When it was settled, epoch ms. */
  settledAt?: number
  /** What settled it: the recheck's output, or the line the model wrote. */
  why?: string
}

/** This session's items; in $.state, so a hot reload keeps them. */
export type Track = {
  nextId: number
  issues: Issue[]
  /** The model's claims already handed to the verifier, so none is checked twice. */
  seen: string[]
  /** How many checks during the work called a model since the person's last prompt (each may make several calls). */
  runs: number
}

/** What was last put to the model, drawn in the band above the prompt. */
export type Cards = {
  /** When the check that found them settled, epoch ms. */
  at: number
  items: Finding[]
}

declare module 'claude-code' {
  interface PluginState {
    'deepseek-supervisor': { cards: Cards | null; isHidden: boolean; track: Track }
  }
}
