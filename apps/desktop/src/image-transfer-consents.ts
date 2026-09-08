/** Provider-specific image consent stored outside the ephemeral renderer origin. */
import { readFile } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { GONGCHUANG_MODEL_PROVIDERS, isGongchuangModelProvider, type GongchuangModelProvider } from '@gongchuang/model-connections/registry'

/** IPC channel for reading explicitly granted provider consent. */
export const IMAGE_TRANSFER_CONSENTS_READ_CHANNEL = 'gongchuang:image-transfer-consents:read'
/** IPC channel for persisting one explicit provider approval. */
export const IMAGE_TRANSFER_CONSENT_REMEMBER_CHANNEL = 'gongchuang:image-transfer-consents:remember'

function providerId(value: unknown): GongchuangModelProvider {
  if (!isGongchuangModelProvider(value)) throw new Error('Unknown image-transfer provider')
  return value
}

/** Stores only provider IDs explicitly approved in the native product dialog. */
export class ImageTransferConsentStore {
  private writes: Promise<void> = Promise.resolve()

  constructor(private readonly filename: string) {}

  /**
   * Read durable grants after preceding writes settle.
   * @returns validated provider IDs; malformed or inaccessible files reject.
   */
  async read(): Promise<readonly GongchuangModelProvider[]> {
    await this.writes
    return this.readDocument()
  }

  /**
   * Persist one approved provider without accepting file identities or credentials.
   * @param value - provider ID supplied over renderer IPC.
   * @returns completion after the private consent file is atomically replaced.
   */
  remember(value: unknown): Promise<void> {
    const provider = providerId(value)
    const write = this.writes.then(async () => {
      const providers = [...new Set([...await this.readDocument(), provider])].sort()
      await writeFileAtomic(this.filename, `${JSON.stringify({ schemaVersion: 1, providers })}\n`, {
        mode: 0o600, dirMode: 0o700,
      })
    })
    // A failed write is reported to its caller and does not poison later retries.
    this.writes = write.catch(() => {})
    return write
  }

  private async readDocument(): Promise<readonly GongchuangModelProvider[]> {
    let text: string
    try { text = await readFile(this.filename, 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null || !('schemaVersion' in value) || value.schemaVersion !== 1
      || !('providers' in value) || !Array.isArray(value.providers) || value.providers.length > GONGCHUANG_MODEL_PROVIDERS.length) {
      throw new Error('Invalid image-transfer consent document')
    }
    return [...new Set(value.providers.map(providerId))]
  }
}
