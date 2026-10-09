/** The kinds of slip the reviewer looks for; anything else is dropped. */
export type Category =
  | 'silent-reading'
  | 'unraised-problem'
  | 'unbacked-claim'
  | 'untried-cannot'
  | 'scope-creep'
  | 'guessing'
  | 'silent-change'
  | 'ignored-instruction'

/** `high`: going on as it is gives the person a wrong or unwanted result. */
export type Severity = 'high' | 'medium'

export type Finding = {
  category: Category
  severity: Severity
  /** What the assistant should check or ask, in one plain sentence. */
  what: string
  /** Copied verbatim from the conversation; a finding whose quote is not found there is dropped. */
  quote: string
  /** Where it shows: a file, a command, a step. */
  evidence: string
  /** What goes wrong if the assistant keeps going as it is. */
  cost: string
}

/** A finding the model has been told of, and what became of it. */
export type Raised = Finding & {
  id: string
  /** When it was raised, epoch ms. */
  at: number
  /** `escalated`: still open after several passes, so the person was told the model let it lie. */
  status: 'open' | 'resolved' | 'escalated'
  /** How many later passes found it still open. */
  seen: number
}

/** What the watcher last noted, drawn in the band above the prompt. */
export type Cards = {
  /** When the check that found them settled, epoch ms. */
  at: number
  items: Finding[]
  /** Items the model was told of and left alone, raised again to the person. */
  ignored: Finding[]
}

/** The watcher's own record for the session, held by the host so a reload keeps it. */
export type Ledger = {
  /** Main-loop steps since the last pass started. */
  steps: number
  /** Passes this session. */
  passes: number
  /** Items told to the model this session. */
  told: number
  /** The status line's "last:" part. */
  last: string
  /** The person's prompts since the band last changed. */
  promptsSinceCards: number
  /** Follow-up turns the watcher started since the person's last prompt. */
  wakes: number
  nextId: number
  raised: Raised[]
}

declare module 'claude-code' {
  interface PluginState {
    'deepseek-supervisor': { cards: Cards | null; isHidden: boolean; ledger: Ledger }
  }
}
