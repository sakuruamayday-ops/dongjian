declare module 'unzipper' {
  import type { Readable } from 'node:stream'

  export interface Entry {
    readonly externalFileAttributes?: number
    readonly path: string
    readonly type: 'File' | 'Directory'
    readonly uncompressedSize?: number
    readonly versionMadeBy?: number
    stream(): Readable
  }

  export interface Directory {
    readonly files: readonly Entry[]
  }

  export const Open: {
    buffer(value: Buffer): Promise<Directory>
    file(path: string): Promise<Directory>
  }
}
