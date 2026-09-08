/** Client range access and type narrowing for aligned Session history records. */

import type {
  SessionHistoryRecord,
} from '../../types.ts'
import type { SessionEventLikeEntry } from '../contract/events.ts'

interface RootToolLocation {
  readonly turn: number
  readonly step: number
}

interface LegacyCodeDispatchData {
  readonly rootCallId?: unknown
  readonly turn?: unknown
  readonly step?: unknown
}

function validCoordinate(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

/**
 * Restore coordinates omitted by pre-alpha.1 nested Tool recordings.
 *
 * History pagination keeps a Tool result with its source call and enclosed
 * dispatch events, so the preceding root call is trusted location evidence.
 * Unresolved, partial, or conflicting payloads remain untouched and therefore
 * continue to fail closed in business matchers.
 */
function projectLegacyCodeDispatchLocations(
  records: readonly SessionHistoryRecord[],
): readonly SessionEventLikeEntry[] {
  const rootLocations = new Map<string, RootToolLocation>()
  let projected: SessionEventLikeEntry[] | undefined

  for (let index = 0; index < records.length; index++) {
    const record = records[index] as unknown as SessionEventLikeEntry
    const event = record.event
    if (event.type === 'tool/call') {
      const { callId, turn, step } = event.data
      if (typeof callId === 'string' && callId !== ''
        && validCoordinate(turn) && validCoordinate(step)) {
        rootLocations.set(callId, { turn, step })
      }
    }

    // The Tool event vocabulary is module-augmented outside this transport
    // package, so keep compatibility inspection structural at this boundary.
    const legacyEvent = event as unknown as {
      readonly type: string
      readonly data: LegacyCodeDispatchData
    }
    if (legacyEvent.type !== 'tool/code-dispatch-start' && legacyEvent.type !== 'tool/code-dispatch') continue
    const data = legacyEvent.data
    if (data.turn !== undefined || data.step !== undefined || typeof data.rootCallId !== 'string') continue
    const location = rootLocations.get(data.rootCallId)
    if (location === undefined) continue

    projected ??= records.map(candidate => candidate as unknown as SessionEventLikeEntry)
    projected[index] = {
      type: 'event',
      event: {
        ...event,
        data: { ...data, ...location },
      },
    } as SessionEventLikeEntry
  }
  return projected ?? (records as unknown as readonly SessionEventLikeEntry[])
}

/**
 * Narrow aligned wire records to their Client event types without allocation.
 * @param records - validated history transport records.
 * @returns the same record array with typed inner events.
 */
export function historyEntries(
  records: readonly SessionHistoryRecord[],
): readonly SessionEventLikeEntry[] {
  return projectLegacyCodeDispatchLocations(records)
}

/**
 * Read the first logical sequence represented by one wire record.
 * @param record - validated Session event.
 * @returns inclusive first Session sequence.
 */
export function historyRecordFirstSeq(record: SessionHistoryRecord): number {
  return record.event.seq
}

/**
 * Read the final logical sequence represented by one wire record.
 * @param record - validated Session event.
 * @returns inclusive final Session sequence.
 */
export function historyRecordLastSeq(record: SessionHistoryRecord): number {
  return record.event.seq
}
