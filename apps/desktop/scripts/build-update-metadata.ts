/** Generate electron-updater metadata from finished desktop artifacts. */

import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { desktopReleaseNotes } from './release-notes.ts'

type UpdatePlatform = 'darwin' | 'win32'
type UpdateArch = 'arm64' | 'x64'

interface UpdateArtifact {
  readonly filename: string
  readonly sha512: string
  readonly size: number
}

function requiredArgument(argumentsMap: ReadonlyMap<string, string>, name: string): string {
  const value = argumentsMap.get(name)
  if (value === undefined || value.trim() === '') throw new Error(`--${name} is required`)
  return value
}

async function artifact(path: string): Promise<UpdateArtifact> {
  const info = lstatSync(path)
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`更新产物不是普通文件：${path}`)
  const digest = createHash('sha512')
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return { filename: basename(path), sha512: digest.digest('base64'), size: info.size }
}

function yamlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/**
 * Build the platform update manifest consumed by electron-updater.
 * @param desktopRoot - Directory containing the desktop package manifest.
 * @param releaseDir - Directory containing finished installer artifacts.
 * @param platform - Desktop platform represented by the manifest.
 * @param releaseDate - ISO timestamp recorded in the generated manifest.
 * @param arch - macOS architecture represented by the primary artifact.
 * @returns Absolute path of the generated update manifest.
 */
export async function buildUpdateMetadata(
  desktopRoot: string,
  releaseDir: string,
  platform: UpdatePlatform,
  releaseDate = new Date().toISOString(),
  arch: UpdateArch = platform === 'darwin' ? 'arm64' : 'x64',
): Promise<string> {
  const packageManifest = JSON.parse(readFileSync(join(desktopRoot, 'package.json'), 'utf8')) as { version?: unknown }
  if (typeof packageManifest.version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(packageManifest.version)) {
    throw new Error('桌面客户端版本号无效')
  }
  if (!Number.isFinite(Date.parse(releaseDate))) throw new Error('更新发布日期无效')
  if (platform === 'win32' && arch !== 'x64') throw new Error('Windows 更新元数据只支持 x64')
  const version = packageManifest.version
  const prefix = `Dongjian-${version}`
  const filenames = platform === 'darwin'
    ? [`${prefix}-mac-${arch}.zip`, `${prefix}-mac-${arch}.dmg`]
    : [`${prefix}-win-x64.exe`]
  const artifacts = await Promise.all(filenames.map(filename => artifact(join(releaseDir, filename))))
  const allArtifacts = platform === 'darwin'
    ? [...artifacts, ...(await Promise.all(
      (['arm64', 'x64'] as const)
        .filter(candidate => candidate !== arch)
        .flatMap(candidate => [
          `${prefix}-mac-${candidate}.zip`,
          `${prefix}-mac-${candidate}.dmg`,
        ])
        .filter((filename) => {
          try { return lstatSync(join(releaseDir, filename)).isFile() } catch { return false }
        })
        .map(filename => artifact(join(releaseDir, filename))),
    ))]
    : artifacts
  const primary = artifacts[0]
  if (primary === undefined) throw new Error('更新产物为空')
  const target = join(releaseDir, platform === 'darwin' ? 'latest-mac.yml' : 'latest.yml')
  const content = [
    `version: ${version}`,
    'files:',
    ...allArtifacts.flatMap(row => [
      `  - url: ${yamlString(row.filename)}`,
      `    sha512: ${row.sha512}`,
      `    size: ${String(row.size)}`,
    ]),
    `path: ${yamlString(primary.filename)}`,
    `sha512: ${primary.sha512}`,
    `releaseDate: ${yamlString(releaseDate)}`,
    `releaseNotes: ${yamlString(desktopReleaseNotes(desktopRoot, version))}`,
    '',
  ].join('\n')
  const temporary = `${target}.next-${randomUUID()}`
  writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o644, flag: 'wx' })
  renameSync(temporary, target)
  return target
}

async function main(): Promise<void> {
  const argumentsMap = new Map<string, string>()
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index]
    const value = process.argv[index + 1]
    if (key === undefined || value === undefined || !key.startsWith('--')) {
      throw new Error('usage: build-update-metadata.ts --platform <darwin|win32> --arch <arm64|x64> --release-dir <dir>')
    }
    argumentsMap.set(key.slice(2), value)
  }
  const platform = requiredArgument(argumentsMap, 'platform')
  if (platform !== 'darwin' && platform !== 'win32') throw new Error('--platform must be darwin or win32')
  const arch = argumentsMap.get('arch') ?? (platform === 'darwin' ? 'arm64' : 'x64')
  if (arch !== 'arm64' && arch !== 'x64') throw new Error('--arch must be arm64 or x64')
  const desktopRoot = resolve(import.meta.dirname, '..')
  const target = await buildUpdateMetadata(
    desktopRoot,
    resolve(desktopRoot, requiredArgument(argumentsMap, 'release-dir')),
    platform,
    undefined,
    arch,
  )
  process.stdout.write(`${target}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main()
