import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** @param desktopRoot - Desktop package root. @param version - Exact package version. @returns That version's public notes only. */
export function desktopReleaseNotes(desktopRoot: string, version: string): string {
  const path = join(desktopRoot, 'release-notes', `${version}.md`)
  return existsSync(path) ? readFileSync(path, 'utf8').trim().slice(0, 8_000) : ''
}
