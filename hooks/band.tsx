import { atom, read, update } from 'claude-code'
import type { On } from 'claude-code'

// What the watcher last noted, above the prompt: the person sees it as it lands, the
// way "You should know" shows its cards. The model has already read the same items
// as a note; the band is only the person's copy.
const cards = atom({ plugin: 'deepseek-supervisor', key: 'cards' } as const, null)
const isHidden = atom({ plugin: 'deepseek-supervisor', key: 'isHidden' } as const, false)

const hhmm = (ms: number) => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export const registerBand = (on: On) => {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const shown = await read($, cards)
    if (shown === null || shown.items.length === 0 || (await read($, isHidden))) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Box>
          <Text bold>
            deepseek-supervisor · noted {shown.items.length} ({hhmm(shown.at)}){' '}
          </Text>
          <Button key="hide" label="Hide" onPress={() => update($, isHidden, () => true)} />
        </Box>
        {shown.items.map((f, i) => (
          <Text key={`item-${i}`} wrap="truncate-end">
            {i + 1}. {f.what}
          </Text>
        ))}
      </Box>
    )
  })
}
