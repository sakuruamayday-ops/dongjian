/** UTF-8 log-file preparation for legacy Windows readers. */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])

/** Ensure a log is recognized as UTF-8 without changing its existing text bytes. */
export function ensureUtf8LogFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true })
  if (!existsSync(path)) {
    writeFileSync(path, UTF8_BOM, { flag: 'wx', mode: 0o600 })
    return
  }
  const content = readFileSync(path)
  if (content.subarray(0, UTF8_BOM.length).equals(UTF8_BOM)) return
  const mode = statSync(path).mode & 0o777
  writeFileSync(path, Buffer.concat([UTF8_BOM, content]), { flag: 'w', mode })
}
