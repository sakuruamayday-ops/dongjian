/** Format a desktop-owned conversation deep link for the sidebar copy action.
 * @param sessionId - Exact local Session identifier to encode.
 * @returns A product-owned deep link that the desktop protocol handler can open.
 */
export function sessionDeepLink(sessionId: string): string {
  return `dongjian://threads/${encodeURIComponent(sessionId)}`
}
