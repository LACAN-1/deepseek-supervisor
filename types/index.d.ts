export type Finding = {
  /** What happened, in one plain sentence. */
  what: string
  /** Where it shows: a quote, a file, a command from the conversation. */
  evidence: string
  /** What goes wrong if the assistant keeps going as it is. */
  cost: string
}

/** What the watcher last noted, drawn in the band above the prompt. */
export type Cards = {
  /** When the check that found them settled, epoch ms. */
  at: number
  items: Finding[]
}

declare module 'claude-code' {
  interface PluginState {
    'deepseek-supervisor': { cards: Cards | null; isHidden: boolean }
  }
}
