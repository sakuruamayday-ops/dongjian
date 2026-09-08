/** LaunchServices' registered document handlers, without shell scripts or guessed app names. */
import { basename } from 'node:path'
import { lstat, realpath } from 'node:fs/promises'

/** One installed native document application. Its path remains a main-process validated identifier. */
export interface FileApplication {
  readonly id: string
  readonly name: string
  readonly isDefault: boolean
  readonly iconUrl?: string
}

interface NativeFunction { (...args: unknown[]): unknown }
interface NativeLibrary { func(declaration: string): NativeFunction }
interface Koffi { load(path: string): NativeLibrary }

interface DocumentHandlers { paths: string[]; defaultPath: string | null; names: ReadonlyMap<string, string> }
let readHandlers: ((path: string) => DocumentHandlers) | undefined

async function loadHandlers(): Promise<NonNullable<typeof readHandlers>> {
  if (readHandlers !== undefined) return readHandlers
  const koffi = (await import('koffi')).default as unknown as Koffi
  const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
  const ls = koffi.load('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/LaunchServices')
  const createUrl = cf.func('void *CFURLCreateFromFileSystemRepresentation(void *allocator, const uint8_t *bytes, long length, bool directory)')
  const copyPath = cf.func('void *CFURLCopyFileSystemPath(void *url, int style)')
  const release = cf.func('void CFRelease(void *value)')
  const count = cf.func('long CFArrayGetCount(void *array)')
  const at = cf.func('void *CFArrayGetValueAtIndex(void *array, long index)')
  const stringLength = cf.func('long CFStringGetLength(void *string)')
  const maxBytes = cf.func('long CFStringGetMaximumSizeForEncoding(long length, uint32_t encoding)')
  const getString = cf.func('bool CFStringGetCString(void *string, void *buffer, long size, uint32_t encoding)')
  const createString = cf.func('void *CFStringCreateWithCString(void *allocator, const char *text, uint32_t encoding)')
  const createBundle = cf.func('void *CFBundleCreate(void *allocator, void *url)')
  const bundleValue = cf.func('void *CFBundleGetValueForInfoDictionaryKey(void *bundle, void *key)')
  const allApps = ls.func('void *LSCopyApplicationURLsForURL(void *url, uint32_t roles)')
  const defaultApp = ls.func('void *LSCopyDefaultApplicationURLForURL(void *url, uint32_t roles, void *error)')
  const textOf = (string: unknown): string | null => {
    if (string === null) return null
    const bytes = Buffer.alloc(Number(maxBytes(stringLength(string), 0x08000100)) + 1)
    return getString(string, bytes, bytes.length, 0x08000100) === true
      ? bytes.subarray(0, bytes.indexOf(0)).toString('utf8') : null
  }
  const pathOf = (url: unknown): string | null => {
    if (url === null) return null
    const string = copyPath(url, 0)
    if (string === null) return null
    try { return textOf(string) } finally { release(string) }
  }
  const nameOf = (path: string): string | null => {
    const bytes = Buffer.from(path, 'utf8')
    const url = createUrl(null, bytes, bytes.length, true)
    if (url === null) return null
    const bundle = createBundle(null, url)
    try {
      if (bundle === null) return null
      for (const field of ['CFBundleDisplayName', 'CFBundleName']) {
        const key = createString(null, field, 0x08000100)
        if (key === null) continue
        try {
          // CFBundle resolves localized InfoPlist.strings before the raw bundle dictionary.
          const name = textOf(bundleValue(bundle, key))
          if (name !== null && name !== '') return name
        } finally { release(key) }
      }
      return null
    } finally {
      if (bundle !== null) release(bundle)
      release(url)
    }
  }
  readHandlers = (path) => {
    const bytes = Buffer.from(path, 'utf8')
    const url = createUrl(null, bytes, bytes.length, false)
    if (url === null) throw new Error('无法读取文件类型')
    let applications: unknown = null
    let defaultUrl: unknown = null
    try {
      applications = allApps(url, 0xffffffff)
      defaultUrl = defaultApp(url, 0xffffffff, null)
      const paths: string[] = []
      if (applications !== null) {
        for (let index = 0; index < Number(count(applications)); index++) {
          const value = pathOf(at(applications, index))
          if (value !== null) paths.push(value)
        }
      }
      const defaultPath = pathOf(defaultUrl)
      const names = new Map<string, string>()
      for (const candidate of new Set(defaultPath === null ? paths : [defaultPath, ...paths])) {
        const name = nameOf(candidate)
        if (name !== null) names.set(candidate, name)
      }
      return { paths, defaultPath, names }
    } finally {
      // Copy/Create return owned references; array members are borrowed.
      if (applications !== null) release(applications)
      if (defaultUrl !== null) release(defaultUrl)
      release(url)
    }
  }
  return readHandlers
}

/** @param path - Validated absolute document path. @returns Installed handlers, default first, without duplicates. */
export async function fileApplications(path: string): Promise<readonly FileApplication[]> {
  if (process.platform !== 'darwin') return []
  const { paths, defaultPath, names } = (await loadHandlers())(path)
  const candidates = defaultPath === null ? paths : [defaultPath, ...paths]
  const result = new Map<string, FileApplication>()
  for (const candidate of candidates) {
    try {
      const canonical = await realpath(candidate)
      if (!(await lstat(canonical)).isDirectory() || !canonical.endsWith('.app')) continue
      const previous = result.get(canonical)
      result.set(canonical, {
        id: canonical, name: names.get(candidate) ?? basename(canonical, '.app'),
        isDefault: previous?.isDefault === true || candidate === defaultPath,
      })
    } catch {
      // LaunchServices can retain a removed app. Do not offer a dead menu row.
    }
  }
  return [...result.values()].sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name))
}
