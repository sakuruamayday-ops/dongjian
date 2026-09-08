/**
 * Select current instructions from the numbered-annotation message envelope.
 * @param text - Exact model-facing user message.
 * @returns User comments and body for intent routing; quoted history stays in the model request.
 */
export function annotationIntentText(text: string): string {
  // This is a routing projection, never an authorization or artifact-validation
  // result. The Host independently recognizes the Client's v1 display envelope.
  const prefix = '[gongchuang-annotations:v1]'
  if (!text.startsWith(prefix)) return text
  const end = text.indexOf('\n')
  const line = end === -1 ? text : text.slice(0, end)
  let annotations: unknown
  try { annotations = JSON.parse(line.slice(prefix.length)) } catch { return text }
  if (!Array.isArray(annotations) || annotations.length === 0) return text
  const comments: string[] = []
  let previous = 0
  for (const annotation of annotations) {
    if (typeof annotation !== 'object' || annotation === null) return text
    const { index, text: quote, comment, source } = annotation as {
      index?: unknown
      text?: unknown
      comment?: unknown
      source?: { nodeKey?: unknown; kind?: unknown } | null
    }
    if (
      typeof index !== 'number' || !Number.isSafeInteger(index) || index <= previous
      || typeof quote !== 'string' || quote.trim() === '' || typeof comment !== 'string'
      || typeof source !== 'object' || source === null || typeof source.nodeKey !== 'string'
      || source.nodeKey === '' || (source.kind !== 'user' && source.kind !== 'assistant')
    ) return text
    comments.push(comment)
    previous = index
  }
  return [...comments, end === -1 ? '' : text.slice(end + 1)].filter(part => part !== '').join('\n')
}

/**
 * Select user-authored instructions without product attachment hints or quoted history.
 * @param text - Complete model-facing message, retained when no display projection exists.
 * @param displayText - Existing Client projection containing the user's text and attachment references.
 * @returns Text for task routing only; model context and tool authorization remain unchanged.
 */
export function userIntentText(text: string, displayText?: string): string {
  // 附件读取指引属于产品上下文，不是用户要求开展的业务。文件名也不能单独启动专业任务。
  const authored = displayText === undefined ? text : displayText.split('\n')
    .filter(line => !/^@"导入资料\/[^"\\\u0000-\u001f]+"$/u.test(line))
    .join('\n').trimStart()
  return annotationIntentText(authored)
}
