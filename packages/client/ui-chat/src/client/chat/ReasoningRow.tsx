/** Assistant reasoning disclosure, independent of Tool-call presentation. */
import { useState } from 'react'
import { DisclosureRow, IconThinkOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import a11yCss from './accessibility.module.css'
import css from './ReasoningRow.module.css'

function firstLine(text: string): string {
  const newline = text.indexOf('\n')
  return newline === -1 ? text : text.slice(0, newline)
}

function latestLine(text: string): string {
  const visible = text.trimEnd()
  const newline = visible.lastIndexOf('\n')
  return newline === -1 ? visible : visible.slice(newline + 1)
}

function englishDominant(text: string): boolean {
  const cjk = text.match(/[\u3400-\u9fff]/gu)?.length ?? 0
  const latin = text.match(/[A-Za-z]/gu)?.length ?? 0
  return latin > 0 && latin >= cjk * 3
}

/**
 * Render one assistant reasoning block as the Think disclosure row.
 * @param props.text - complete or streaming reasoning text.
 * @param props.running - whether this block is the streaming tail.
 * @param props.t - conversation locale seat for the running status.
 * @returns the reasoning disclosure.
 */
export function ReasoningRow({ text, running, t }: { text: string; running: boolean; t: ChatViewSlotProps['t'] }) {
  const [expanded, setExpanded] = useState(false)
  // Locale owns html.lang. Presentation never translates or rewrites the persisted reasoning.
  const rawSummary = running ? latestLine(text) : firstLine(text)
  // Chinese filenames inside English reasoning do not make its preview Chinese.
  const hidden = document.documentElement.lang.toLowerCase().startsWith('zh')
    && (englishDominant(text) || englishDominant(rawSummary))
  const visibleText = hidden ? t(running ? 'reasoning.nonChinese.running' : 'reasoning.nonChinese.completed') : text
  const summary = running ? latestLine(visibleText) : firstLine(visibleText)

  return (
    <div
      className={css.root}
      data-variant="think"
      data-state={running ? 'running' : 'ok'}
      data-expanded={expanded || undefined}
      data-non-chinese-hidden={hidden || undefined}
    >
      {running && <span className={a11yCss.visuallyHidden}>{t('row.running')}</span>}
      <DisclosureRow
        rowClassName={css.row}
        leadingClassName={css.leading}
        titleClassName={css.title}
        chevronClassName={css.chevron}
        icon={<IconThinkOutline14 size={14} />}
        title={t('message.think')}
        open={expanded && !hidden}
        expandable={!hidden}
        expandOnRowClick
        onToggle={() => { if (!hidden) setExpanded(value => !value) }}
        collapsedContent={(
          <>
            <span className={css.separator} aria-hidden />
            <span className={css.summary} data-follow-end={running || undefined}>
              <span className={css.summaryText}>{summary}</span>
            </span>
          </>
        )}
      >
        <div className={css.thinkBody}>{visibleText}</div>
      </DisclosureRow>
    </div>
  )
}
