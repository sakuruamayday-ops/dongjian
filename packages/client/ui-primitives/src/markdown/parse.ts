/**
 * The markdown renderer's two mdast grammars, one per rendering arm. Each
 * arm is internally consistent — the incremental tail parses, the one-shot
 * parses, and the plain-text projection of a given grammar always agree on
 * where blocks start and end — and the settled grammar is the streaming one
 * plus the math extensions, so the arms differ only where TeX delimiters
 * begin a math construct (a `$$` block is a paragraph while streaming and a
 * math block once settled, by design).
 */

import type { Root } from 'mdast'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { mathFromMarkdown } from 'mdast-util-math'
import { gfm } from 'micromark-extension-gfm'
import { math } from 'micromark-extension-math'
import { cjkFriendlyStrong } from './cjkFriendlyStrong.ts'
import { mathCompatibility } from './mathCompatibility.ts'

const CJK_AUTOLINK_TERMINATOR = /[、。！？：；，）》」』】]/u

interface MutableMarkdownNode {
  type: string
  url?: string
  value?: string
  children?: MutableMarkdownNode[]
  position?: { start?: { offset?: number } }
}

function splitBareUrlsInAutolinkTail(value: string): MutableMarkdownNode[] {
  const match = /https?:\/\/[^\s<>]+/iu.exec(value)
  if (match === null) return [{ type: 'text', value }]
  const before = value.slice(0, match.index)
  const matchedUrl = match[0]
  const terminator = matchedUrl.search(CJK_AUTOLINK_TERMINATOR)
  const url = terminator > 0 ? matchedUrl.slice(0, terminator) : matchedUrl
  const consumed = match.index + url.length
  return [
    ...(before.length > 0 ? [{ type: 'text', value: before }] : []),
    { type: 'link', url, children: [{ type: 'text', value: url }] },
    ...splitBareUrlsInAutolinkTail(value.slice(consumed)),
  ]
}

/**
 * GFM's bare-URL grammar does not treat full-width Chinese punctuation as a
 * boundary, so a model-authored `https://example.com。后文` otherwise turns
 * the entire Chinese sentence into one anchor. Only trim literal autolinks
 * whose source starts directly with HTTP(S); explicit Markdown links and
 * angle-bracket autolinks retain their authored destination unchanged.
 */
function trimCjkBareAutolinkTails(root: Root, source: string): Root {
  const visit = (node: MutableMarkdownNode): void => {
    const children = node.children
    if (children === undefined) return
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index]
      if (child === undefined) continue
      const linkText = child.type === 'link' && child.children?.length === 1
        ? child.children[0]
        : undefined
      const start = child.position?.start?.offset
      const isLiteralHttp = typeof start === 'number'
        && /^https?:/iu.test(source.slice(start, start + 8))
      if (isLiteralHttp && typeof child.url === 'string' && linkText?.type === 'text'
        && linkText.value === child.url) {
        const terminator = child.url.search(CJK_AUTOLINK_TERMINATOR)
        if (terminator > 0) {
          const tail = child.url.slice(terminator)
          child.url = child.url.slice(0, terminator)
          linkText.value = child.url
          const tailNodes = splitBareUrlsInAutolinkTail(tail)
          children.splice(index + 1, 0, ...tailNodes)
          index += tailNodes.length
        }
      }
      visit(child)
    }
  }
  visit(root as MutableMarkdownNode)
  return root
}

/**
 * Parse GFM markdown (the streaming arm's grammar: no math, so incomplete
 * TeX never flashes KaTeX errors mid-stream).
 * @param text - Markdown source.
 * @returns The mdast root.
 */
export function parseGfm(text: string): Root {
  return trimCjkBareAutolinkTails(fromMarkdown(text, {
    extensions: [gfm(), cjkFriendlyStrong()],
    mdastExtensions: [gfmFromMarkdown()],
  }), text)
}

/**
 * Parse GFM markdown plus TeX math with the compatibility delimiters
 * (the settled arm's grammar).
 * @param text - Markdown source.
 * @returns The mdast root.
 */
export function parseGfmWithMath(text: string): Root {
  return trimCjkBareAutolinkTails(fromMarkdown(text, {
    extensions: [gfm(), cjkFriendlyStrong(), mathCompatibility(), math()],
    mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
  }), text)
}
