/** Public-only DNS policy for third-party skill repository transport. */

import { lookup } from 'node:dns/promises'
import { BlockList, isIP, type LookupFunction } from 'node:net'

/**
 * Data contract for resolved address.
 */
export interface ResolvedAddress {
  readonly address: string
  readonly family: 4 | 6
}

/**
 * Data contract for repository resolver seams.
 */
export interface RepositoryResolverSeams {
  readonly lookup?: typeof lookup
  readonly fetch?: typeof globalThis.fetch
}

const TRUSTED_DOH_ENDPOINT = 'https://dns.alidns.com/resolve'
const DOH_TIMEOUT_MS = 5_000

const blockedIPv4 = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) blockedIPv4.addSubnet(network, prefix, 'ipv4')

const syntheticProxyIPv4 = new BlockList()
syntheticProxyIPv4.addSubnet('198.18.0.0', 15, 'ipv4')

const globalIPv6 = new BlockList()
globalIPv6.addSubnet('2000::', 3, 'ipv6')

const blockedIPv6 = new BlockList()
for (const [network, prefix] of [
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['2001::', 32],
  ['2001:2::', 48],
  ['2001:10::', 28],
  ['2001:20::', 28],
  ['2001:db8::', 32],
  ['2002::', 16],
] as const) blockedIPv6.addSubnet(network, prefix, 'ipv6')

/**
 * Perform the is public repository address operation.
 * @param address - The address value.
 * @returns The is public repository address result.
 */
export function isPublicRepositoryAddress(address: string): boolean {
  const unwrapped = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address
  const family = isIP(unwrapped)
  if (family === 4) return !blockedIPv4.check(unwrapped, 'ipv4')
  if (family === 6) return globalIPv6.check(unwrapped, 'ipv6') && !blockedIPv6.check(unwrapped, 'ipv6')
  return false
}

function blocked(hostname: string): Error {
  return new Error(`仓库地址 ${hostname} 解析到本机或内网，已阻止连接`)
}

function isSyntheticProxyAddress(address: string): boolean {
  return isIP(address) === 4 && syntheticProxyIPv4.check(address, 'ipv4')
}

async function resolveDohFamily(
  hostname: string,
  family: 4 | 6,
  fetcher: typeof globalThis.fetch,
): Promise<ResolvedAddress[]> {
  const url = new URL(TRUSTED_DOH_ENDPOINT)
  url.searchParams.set('name', hostname)
  url.searchParams.set('type', family === 4 ? 'A' : 'AAAA')
  const response = await fetcher(url, {
    method: 'GET', redirect: 'error', headers: { accept: 'application/dns-json' },
    signal: AbortSignal.timeout(DOH_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`独立域名解析返回 HTTP ${String(response.status)}`)
  const payload = await response.json() as { Status?: unknown; Answer?: unknown }
  if (payload.Status !== 0 || (payload.Answer !== undefined && !Array.isArray(payload.Answer))) {
    throw new Error('独立域名解析返回无效结果')
  }
  const expectedType = family === 4 ? 1 : 28
  const rows: ResolvedAddress[] = []
  for (const item of payload.Answer ?? []) {
    if (typeof item !== 'object' || item === null) continue
    const answer = item as { type?: unknown; data?: unknown }
    if (answer.type === expectedType && typeof answer.data === 'string' && isIP(answer.data) === family) {
      rows.push({ address: answer.data, family })
    }
  }
  return rows
}

/**
 * Perform the assert public repository addresses operation.
 * @param hostname - The hostname value.
 * @param resolved - The resolved value.
 * @returns The assert public repository addresses result.
 */
export function assertPublicRepositoryAddresses(
  hostname: string,
  resolved: readonly ResolvedAddress[],
): readonly ResolvedAddress[] {
  if (resolved.length === 0 || resolved.some(row => !isPublicRepositoryAddress(row.address))) throw blocked(hostname)
  return resolved
}

async function resolveSyntheticProxyHostname(
  hostname: string,
  fetcher: typeof globalThis.fetch,
): Promise<readonly ResolvedAddress[]> {
  const settled = await Promise.allSettled([
    resolveDohFamily(hostname, 4, fetcher),
    resolveDohFamily(hostname, 6, fetcher),
  ])
  const addresses = settled.flatMap(result => result.status === 'fulfilled' ? result.value : [])
  if (addresses.length === 0) throw new Error(`无法独立解析仓库地址 ${hostname}`)
  const unique = [...new Map(addresses.map(row => [`${row.family}:${row.address}`, row])).values()]
  return assertPublicRepositoryAddresses(hostname, unique)
}

/**
 * Perform the resolve public repository addresses operation.
 * @param hostname - The hostname value.
 * @param seams - The seams value.
 * @returns The resolve public repository addresses result.
 */
export async function resolvePublicRepositoryAddresses(
  hostname: string,
  seams: RepositoryResolverSeams = {},
): Promise<readonly ResolvedAddress[]> {
  const unwrapped = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  const literalFamily = isIP(unwrapped)
  if (literalFamily !== 0) {
    if (!isPublicRepositoryAddress(unwrapped)) throw blocked(hostname)
    return [{ address: unwrapped, family: literalFamily as 4 | 6 }]
  }
  let resolved: ResolvedAddress[]
  try {
    resolved = await (seams.lookup ?? lookup)(unwrapped, { all: true, order: 'verbatim' }) as ResolvedAddress[]
  } catch (error: unknown) {
    throw new Error(`无法解析仓库地址 ${hostname}`, { cause: error })
  }
  if (resolved.length > 0 && resolved.every(row => isSyntheticProxyAddress(row.address))) {
    return await resolveSyntheticProxyHostname(unwrapped, seams.fetch ?? globalThis.fetch)
  }
  return assertPublicRepositoryAddresses(hostname, resolved)
}

/**
 * Perform the pinned repository lookup operation.
 * @param addresses - The addresses value.
 * @returns The pinned repository lookup result.
 */
export function pinnedRepositoryLookup(addresses: readonly ResolvedAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    if (addresses.length === 0) {
      callback(Object.assign(new Error('没有已验证的公网地址'), { code: 'ENOTFOUND' }), '', 0)
      return
    }
    if (options.all === true) {
      callback(null, addresses.map(row => ({ ...row })))
      return
    }
    const requestedFamily = options.family === 4 || options.family === 6 ? options.family : undefined
    const selected = addresses.find(row => requestedFamily === undefined || row.family === requestedFamily)
    if (selected === undefined) {
      callback(Object.assign(new Error('已验证地址不支持请求的协议族'), { code: 'EAI_ADDRFAMILY' }), '', 0)
      return
    }
    callback(null, selected.address, selected.family)
  }
}
