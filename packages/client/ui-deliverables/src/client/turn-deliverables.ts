/**
 * Turn-scoped produced-file Definition and readers. Client-only and
 * model-free: the vocabulary comes from successful first-party mutation
 * calls, never presentation data or the closing prose.
 */
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import type { TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ConversationMatch, ConversationNodeContext, ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { MarkdownFileMentions } from '@deepseek-ai/dsh-client-ui-primitives'

interface ProducedPath {
  readonly seq: number
  readonly path: string
  /** True when the explicit publication tool verified that this file can be opened. */
  readonly published?: boolean
}

/** Host-owned quality classification, independent from a file's openability. */
export interface ClassifiedDelivery {
  readonly turn: number
  readonly phase: 'running' | 'paused' | 'waiting-user' | 'draft' | 'failed' | 'formal'
  readonly files: readonly { readonly originalPath: string; readonly path: string }[]
  readonly issues: readonly string[]
  /** Retained chat candidate, visibly unverified and never a formal answer. */
  readonly draftText?: string
}

/** One file chip, optionally classified by the product's existing validator. */
export interface ProducedFileEntry {
  readonly path: string
  readonly phase?: ClassifiedDelivery['phase']
  readonly issues?: readonly string[]
}

function deliveryNotice(value: unknown): ClassifiedDelivery | undefined {
  if (!isRecord(value) || !isRecord(value.source)) return undefined
  const source = value.source
  if (source.kind !== 'plugin' || source.plugin !== 'gongchuang-policy-gate') return undefined
  const delivery = source.delivery
  if (!isRecord(delivery) || !Number.isSafeInteger(delivery.turn) || Number(delivery.turn) < 0
    || !['running', 'paused', 'waiting-user', 'draft', 'failed', 'formal'].includes(String(delivery.phase))
    || !Array.isArray(delivery.files) || !Array.isArray(delivery.issues)
    || !delivery.issues.every(issue => typeof issue === 'string')
    || (delivery.draftText !== undefined && typeof delivery.draftText !== 'string')
    || !delivery.files.every(file => isRecord(file)
      && pathValue(file.path) !== null && pathValue(file.originalPath) !== null)) return undefined
  return delivery as unknown as ClassifiedDelivery
}

/** Immutable produced-file facts published against one Turn. */
export interface DeliverablesTurnData {
  readonly produced: readonly ProducedPath[]
  readonly classification?: ClassifiedDelivery
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationTurnDataMap {
    /** Successful mutation paths accumulated in this Turn. */
    deliverables: DeliverablesTurnData
  }
}

interface DeliverablesState extends DeliverablesTurnData {
  readonly turn: number
  readonly calls: ReadonlyMap<string, TrackedCall | null>
}

type TrackedCall =
  | { readonly kind: 'mutation'; readonly path: string }
  | { readonly kind: 'publication'; readonly paths: readonly string[] }

const PUBLISH_FILES_TOOL = 'gongchuang_publish_files'
const ARTIFACT_PROBE_TOOL = 'gongchuang_artifact_probe'

interface LocatedPtcDispatch {
  readonly turn?: unknown
  readonly name?: unknown
  readonly arguments?: unknown
  readonly isError?: unknown
}

/**
 * Extract a supported mutation or explicit final-file publication from one
 * root call. Publication remains provisional until its result succeeds.
 * @param name - wire tool name.
 * @param argsRaw - model-produced JSON arguments.
 * @returns the structured call fact, or null when unsupported or malformed.
 */
function trackedCall(name: string, argsRaw: string): TrackedCall | null {
  let args: unknown
  try {
    args = JSON.parse(argsRaw) as unknown
  } catch {
    return null
  }
  if (!isRecord(args)) return null
  if (isPublicationTool(name)) {
    const paths = publicationPaths(name, args)
    return paths.length === 0 ? null : { kind: 'publication', paths }
  }
  const path = mutationPath(name, args)
  return path === null ? null : { kind: 'mutation', path }
}

/** Extract the path from a supported first-party mutation call. */
function mutationPath(name: string, args: Readonly<Record<string, unknown>>): string | null {
  switch (name) {
    case 'write':
      return typeof args.content === 'string' ? pathValue(args.file_path) : null
    case 'edit':
      return validEditArgs(args) ? pathValue(args.file_path) : null
    case 'str_replace_editor':
      return editorMutationPath(args)
    default:
      return null
  }
}

/**
 * Mirror the publication tool's path normalization over structured arguments.
 * A successful result proves these inputs named files; malformed replay data
 * fails closed instead of turning arbitrary result prose into an open action.
 */
function isPublicationTool(name: unknown): boolean {
  return name === PUBLISH_FILES_TOOL || name === ARTIFACT_PROBE_TOOL
}

function publicationPaths(name: unknown, args: unknown): readonly string[] {
  // A successful probe has already inspected the file and checked any current
  // professional binding. It promises the same final-file row as publish_files.
  if (name === ARTIFACT_PROBE_TOOL) {
    const path = isRecord(args) ? pathValue(args.artifactPath) : null
    return path === null ? [] : [path]
  }
  if (!isRecord(args) || !Array.isArray(args.paths)) return []
  if (args.paths.some(path => typeof path !== 'string')) return []
  const paths = [...new Set((args.paths as string[]).map(path => path.trim()).filter(path => path !== ''))]
  return paths.length > 0 && paths.length <= 20 ? paths : []
}

/** Validate the fields that an `edit` execution requires. */
function validEditArgs(args: Readonly<Record<string, unknown>>): boolean {
  return typeof args.old_string === 'string'
    && args.old_string.length > 0
    && typeof args.new_string === 'string'
    && args.old_string !== args.new_string
    && (args.replace_all === undefined || typeof args.replace_all === 'boolean')
}

/** Extract a path only from a complete mutating editor command. */
function editorMutationPath(args: Readonly<Record<string, unknown>>): string | null {
  const path = pathValue(args.path)
  if (path === null) return null
  switch (args.command) {
    case 'create':
      return typeof args.file_text === 'string' ? path : null
    case 'str_replace':
      return typeof args.old_str === 'string'
        && args.old_str.length > 0
        && (args.new_str === undefined || typeof args.new_str === 'string')
        ? path
        : null
    case 'insert':
      return typeof args.insert_line === 'number'
        && Number.isInteger(args.insert_line)
        && args.insert_line >= 0
        && typeof args.new_str === 'string'
        ? path
        : null
    default:
      return null
  }
}

/** A non-blank path preserves the exact spelling supplied to the tool. */
function pathValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function comparableLocalPath(value: string): string {
  return value.trim().replaceAll('\\', '/').replace(/\/{2,}/gu, '/').replace(/\/\.\//gu, '/')
}

function isAbsoluteLocalPath(value: string): boolean {
  const comparable = comparableLocalPath(value)
  return comparable.startsWith('/') || /^[A-Za-z]:\//u.test(comparable)
}

/** Match one absolute workspace path with its model-supplied relative spelling. */
function sameLocalFile(left: string, right: string, cwd?: string): boolean {
  const comparableLeft = comparableLocalPath(left)
  const comparableRight = comparableLocalPath(right)
  if (comparableLeft === comparableRight) return true
  if (isAbsoluteLocalPath(comparableLeft) === isAbsoluteLocalPath(comparableRight)) return false
  const absolute = isAbsoluteLocalPath(comparableLeft) ? comparableLeft : comparableRight
  const relative = isAbsoluteLocalPath(comparableLeft) ? comparableRight : comparableLeft
  // A suffix is not file identity: archive/report.docx differs from report.docx.
  return cwd !== undefined && relative !== ''
    && absolute === comparableLocalPath(`${cwd}/${relative.replace(/^\.\//u, '')}`)
}

function classifiedPath(
  path: string,
  classification: ClassifiedDelivery | undefined,
  cwd?: string,
): string {
  const files = classification?.files ?? []
  const exact = files.find(file => file.originalPath === path)
  if (exact !== undefined) return exact.path
  const logicalMatches = files.filter(file => sameLocalFile(file.originalPath, path, cwd))
  return logicalMatches.length === 1 ? (logicalMatches[0]?.path ?? path) : path
}

function appendLogicalPath(paths: string[], path: string, cwd?: string): void {
  const existing = paths.findIndex(candidate => sameLocalFile(candidate, path, cwd))
  if (existing < 0) {
    paths.push(path)
    return
  }
  // 打开动作优先使用宿主验证过的绝对路径，避免相对路径受当前目录漂移影响。
  if (!isAbsoluteLocalPath(paths[existing] as string) && isAbsoluteLocalPath(path)) paths[existing] = path
}

/** Narrow parsed JSON to an argument object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Files produced by one Turn data value.
 *
 * The source is the arguments of successful `write`, `edit`, and mutating
 * `str_replace_editor` calls, not the closing prose: a produced file must be
 * listed whether or not the model remembered to name it. Reads, unsupported
 * tools, malformed calls, and failed results contribute nothing. Paths keep
 * first-seen order and appear once, so a file written and then edited in the
 * same turn is one entry.
 *
 * The Conversation Location index owns turn membership before this function
 * runs, so paths cannot spill across turns and this derivation does not infer
 * boundaries from neighboring presentation Nodes.
 * @param data - engine-published Deliverables data for one Turn.
 * @param seq - closing Assistant seq; later Tool settlements are excluded.
 * @param cwd - Actual session directory, required to equate relative and absolute spellings.
 * @returns Produced paths in first-seen order; empty when the turn wrote nothing.
 */
export function producedForClosing(
  data: Readonly<DeliverablesTurnData> | undefined,
  seq = Number.POSITIVE_INFINITY,
  cwd?: string,
): readonly string[] {
  if (data === undefined) return []
  const eligible = data.produced.filter(produced => produced.seq <= seq)
  // Explicit publication is the turn's final delivery contract; keep build
  // scripts and other intermediate mutations out of the user-facing row.
  const rows = eligible.some(produced => produced.published === true)
    ? eligible.filter(produced => produced.published === true)
    : eligible
  const paths: string[] = []
  for (const produced of rows) {
    appendLogicalPath(paths, classifiedPath(produced.path, data.classification, cwd), cwd)
  }
  for (const file of data.classification?.files ?? []) {
    appendLogicalPath(paths, file.path, cwd)
  }
  return paths
}

/**
 * Claim the turn-tail chain only when its closing turn produced files.
 * @param owner - Turn-tail owner currency for the closing assistant.
 * @returns Produced paths as the component's match, or null to decline before mount.
 */
export function selectProducedFiles(owner: TurnTailOwnerProps): readonly string[] | null {
  const paths = producedForClosing(owner.turn.data.get('deliverables'), owner.seq, owner.cwd)
  return paths.length === 0 ? null : paths
}

/** Match file chips with the latest Host classification for their own turn.
 * @param owner - The closing assistant's turn and file opener.
 * @returns Classified file rows, or null when the turn has no produced files.
 */
export function selectProducedFileEntries(owner: TurnTailOwnerProps): readonly ProducedFileEntry[] | null {
  const paths = selectProducedFiles(owner)
  if (paths === null) return null
  const classification = owner.turn.data.get('deliverables')?.classification
  return paths.map(path => classification?.files.some(file => file.path === path)
    ? { path, phase: classification.phase, issues: classification.issues }
    : { path })
}

/** Existing file entries plus a Host-retained chat draft for the same turn. */
export interface TurnDeliverablesMatch {
  readonly files: readonly ProducedFileEntry[]
  readonly draftText?: string
  readonly issues: readonly string[]
}

/**
 * Match terminal text even when no file or closing assistant was produced.
 * @param owner - Closing turn and its host file opener.
 * @returns Files and retained terminal draft, or null when the turn has neither.
 */
export function selectTurnDeliverables(owner: TurnTailOwnerProps): TurnDeliverablesMatch | null {
  const files = selectProducedFileEntries(owner) ?? []
  const classification = owner.turn.data.get('deliverables')?.classification
  const terminal = classification?.phase === 'draft' || classification?.phase === 'failed'
  const draftText = terminal && classification.turn === owner.turn.turn ? classification.draftText : undefined
  if (files.length === 0 && !draftText) return null
  return { files, issues: classification?.issues ?? [], ...(draftText ? { draftText } : {}) }
}

function updateDeliverables(state: DeliverablesState, match: ConversationMatch): DeliverablesState {
  if (match.event.type === 'user/message') {
    const classification = deliveryNotice(match.event.data)
    return classification === undefined ? state : { ...state, classification }
  }
  if (match.event.type === 'tool/call') {
    const calls = new Map(state.calls)
    calls.set(String(match.event.data.callId), trackedCall(match.event.data.name, match.event.data.arguments))
    return { ...state, calls }
  }
  if ((match.event.type as string) === 'tool/code-dispatch') {
    const dispatch = match.event.data as LocatedPtcDispatch
    const paths = isPublicationTool(dispatch.name) && dispatch.isError === false
      ? publicationPaths(dispatch.name, dispatch.arguments)
      : []
    return paths.length === 0 ? state : {
      ...state,
      produced: [...state.produced, ...paths.map(path => ({ seq: match.event.seq, path, published: true as const }))],
    }
  }
  if (match.event.type !== 'tool/result') return state
  const result = match.event.data.message.content[0]
  if (result.isError === true) return state
  const callId = String(match.event.data.message.source.callId)
  const call = state.calls.get(callId)
  if (call === null || call === undefined) return state
  const additions = call.kind === 'publication'
    ? call.paths.map(path => ({ seq: match.event.seq, path, published: true as const }))
    : [{ seq: match.event.seq, path: call.path }]
  return additions.length === 0 ? state : { ...state, produced: [...state.produced, ...additions] }
}

function partialDeliverables(context: ConversationNodeContext<DeliverablesState>): DeliverablesState | undefined {
  // A tail page can omit turn/start while retaining complete publication or
  // quality receipts. Read only this turn's matched facts, never closing prose
  // or an orphan result whose call arguments remain outside the loaded page.
  let state: DeliverablesState = { turn: Number(context.id), calls: new Map(), produced: [] }
  for (const match of context.matches) state = updateDeliverables(state, match)
  return state.produced.length === 0 && state.classification === undefined ? undefined : state
}

/** Turn-local successful mutation accumulator; it publishes no view Node. */
export const deliverablesDefinition: ConversationNodeDefinition<DeliverablesState> = {
  kind: 'deliverables',
  match: (event) => {
    if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
    if (event.type === 'user/message') {
      const classification = deliveryNotice(event.data)
      return classification === undefined ? null : { id: String(classification.turn), role: 'update' }
    }
    if (event.type === 'tool/call') return { id: String(event.data.turn), role: 'update' }
    if (event.type === 'tool/result' && isAppendSurfaceEvent(event)) {
      return { id: String(event.data.turn), role: 'update' }
    }
    if ((event.type as string) === 'tool/code-dispatch') {
      // The optional location is absent from old replays and from agent-less
      // embeddings, so narrow the durable payload instead of assuming it.
      const { turn, name } = event.data as LocatedPtcDispatch
      return isPublicationTool(name)
        && typeof turn === 'number'
        && Number.isSafeInteger(turn)
        && turn >= 0
        ? { id: String(turn), role: 'update' }
        : null
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'turn/start') throw new Error('deliverables start requires turn/start')
    return { turn: match.event.data.turn, calls: new Map(), produced: [] }
  },
  update: (context, match) => updateDeliverables(context.state, match),
  buildLocationData: (context, scope, previous) => {
    if (scope !== 'turn') return null
    const state = context.state ?? partialDeliverables(context)
    if (state === undefined) return null
    if (previous?.kind === 'turn'
      && previous.turn === state.turn
      && previous.key === 'deliverables'
      && previous.value.produced === state.produced
      && previous.value.classification === state.classification) return previous
    return {
      kind: 'turn',
      turn: state.turn,
      key: 'deliverables',
      value: {
        produced: state.produced,
        ...(state.classification === undefined ? {} : { classification: state.classification }),
      },
    }
  },
}

/**
 * Trailing path segment, the part that identifies the file at a glance.
 * @param path - Slash- or backslash-separated path.
 * @returns The final segment, or the whole string when separator-free.
 */
export function basename(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return at === -1 ? path : path.slice(at + 1)
}

/**
 * File-mention vocabulary over one turn's produced paths, for the closing
 * message's prose: an inline-code token opens the file it names. A token
 * resolves by exact path, or by being exactly the basename of exactly one
 * produced path — a basename two paths share stays inert rather than
 * guessing, so a mention link can never open the wrong file or 404.
 * @param paths - The turn's produced paths (tool order, already deduped).
 * @param openFile - The chat view's file opener.
 * @param label - Localizes the accessible open-label for a resolved path.
 * @returns The resolver MarkdownText consumes; the full path rides `title`,
 * the same disambiguator the row's chips carry.
 */
export function producedFileMentions(
  paths: readonly string[],
  openFile: (path: string) => void,
  label: (path: string) => string,
): MarkdownFileMentions {
  return {
    resolve(value) {
      const path = paths.includes(value) ? value : onlyPathWithBasename(paths, value)
      if (path === undefined) return undefined
      return { open: () => { openFile(path) }, label: label(path), title: path }
    },
  }
}

/** The single produced path whose basename is exactly `value`, else undefined. */
function onlyPathWithBasename(paths: readonly string[], value: string): string | undefined {
  const matches = paths.filter(path => basename(path) === value)
  return matches.length === 1 ? matches[0] : undefined
}
