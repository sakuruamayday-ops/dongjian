/** Device-local profile avatar persistence for the desktop renderer. */

import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

export const AVATAR_READ_CHANNEL = 'gongchuang:profile-avatar:read'
export const AVATAR_WRITE_CHANNEL = 'gongchuang:profile-avatar:write'

const MAX_AVATAR_BYTES = 512 * 1024
const DATA_URL = /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/u

interface AvatarDocument {
  readonly schemaVersion: 1
  readonly avatarDataUrl: string | null
}

function validatedAvatar(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || value.length > MAX_AVATAR_BYTES * 2) {
    throw new Error('头像数据无效')
  }
  const match = DATA_URL.exec(value)
  if (match?.[1] === undefined || match[1].length % 4 !== 0) throw new Error('头像数据无效')
  const bytes = Buffer.from(match[1], 'base64')
  if (bytes.length === 0 || bytes.length > MAX_AVATAR_BYTES) throw new Error('头像数据无效')
  return value
}

/** Persist only the already cropped image data; never expose its filesystem path to the renderer. */
export class DesktopAvatarStore {
  constructor(private readonly filename: string) {}

  read(): string | null {
    try {
      const parsed = JSON.parse(readFileSync(this.filename, 'utf8')) as Partial<AvatarDocument>
      if (parsed.schemaVersion !== 1) return null
      return validatedAvatar(parsed.avatarDataUrl)
    } catch {
      return null
    }
  }

  async write(value: string | null): Promise<string | null> {
    const avatarDataUrl = validatedAvatar(value)
    const document: AvatarDocument = { schemaVersion: 1, avatarDataUrl }
    await writeFileAtomic(this.filename, `${JSON.stringify(document)}\n`, {
      mode: 0o600,
      dirMode: 0o700,
    })
    return avatarDataUrl
  }

  directory(): string {
    return dirname(this.filename)
  }
}
