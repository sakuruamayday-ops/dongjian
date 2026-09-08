/** DNS resolution and address policy for anonymous HTTP retrieval. */

import { lookup } from 'node:dns/promises'
import { BlockList, isIP, type LookupFunction } from 'node:net'
import { WebError } from '@deepseek-ai/dsh-web'

/** Destination policy applied before the HTTP transport opens a socket. */
export type FetchNetworkPolicy = 'allow-all' | 'public-only'

/** One DNS or literal address eligible for a pinned Node socket lookup. */
export interface ResolvedAddress {
  readonly address: string
  readonly family: 4 | 6
}

/** Injectable resolver seams used by deterministic policy tests. */
export interface NetworkResolverSeams {
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

// Clash and compatible local proxy clients intentionally synthesize this
// benchmark range. It remains blocked for literal URLs and ordinary mixed DNS
// answers; a hostname whose complete answer is synthetic may use the narrowly
// scoped, independently verified DoH fallback below.
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
 * Return true only for globally routable addresses accepted by the public-only policy.
 * @param address - IPv4 or IPv6 literal, optionally bracketed.
 * @returns Whether the literal is allowed as a public destination.
 */
export function isPublicNetworkAddress(address: string): boolean {
  const unwrapped = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address
  const family = isIP(unwrapped)
  if (family === 4) return !blockedIPv4.check(unwrapped, 'ipv4')
  if (family === 6) {
    if (!globalIPv6.check(unwrapped, 'ipv6')) return false
    return !blockedIPv6.check(unwrapped, 'ipv6')
  }
  return false
}

function blocked(hostname: string): WebError {
  return new WebError(`URL host ${hostname} resolves outside the public internet`, 'WEB_BLOCKED_URL')
}

function isSyntheticProxyAddress(address: string): boolean {
  return isIP(address) === 4 && syntheticProxyIPv4.check(address, 'ipv4')
}

/** Resolve one address family through the fixed HTTPS resolver. */
async function resolveDohFamily(
  hostname: string,
  family: 4 | 6,
  fetcher: typeof globalThis.fetch,
): Promise<ResolvedAddress[]> {
  const url = new URL(TRUSTED_DOH_ENDPOINT)
  url.searchParams.set('name', hostname)
  url.searchParams.set('type', family === 4 ? 'A' : 'AAAA')
  const response = await fetcher(url, {
    method: 'GET',
    redirect: 'error',
    headers: { accept: 'application/dns-json' },
    signal: AbortSignal.timeout(DOH_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`DoH returned HTTP ${response.status}`)
  const payload = await response.json() as { Status?: unknown; Answer?: unknown }
  if (payload.Status !== 0 || (payload.Answer !== undefined && !Array.isArray(payload.Answer))) {
    throw new Error('DoH returned an invalid answer')
  }
  const expectedType = family === 4 ? 1 : 28
  const rows: ResolvedAddress[] = []
  for (const item of payload.Answer ?? []) {
    if (typeof item !== 'object' || item === null) continue
    const answer = item as { type?: unknown; data?: unknown }
    if (answer.type !== expectedType || typeof answer.data !== 'string') continue
    if (isIP(answer.data) === family) rows.push({ address: answer.data, family })
  }
  return rows
}

/**
 * Replace an all-synthetic proxy DNS answer with independently resolved,
 * globally routable socket targets. The HTTPS resolver is fixed and receives
 * only the hostname; target cookies, headers, and credentials never cross it.
 */
async function resolveSyntheticProxyHostname(
  hostname: string,
  fetcher: typeof globalThis.fetch,
): Promise<readonly ResolvedAddress[]> {
  const settled = await Promise.allSettled([
    resolveDohFamily(hostname, 4, fetcher),
    resolveDohFamily(hostname, 6, fetcher),
  ])
  const addresses = settled.flatMap(result => result.status === 'fulfilled' ? result.value : [])
  if (addresses.length === 0) {
    const failure = settled.find(result => result.status === 'rejected')
    throw new WebError(`cannot independently resolve URL host ${hostname}`, 'WEB_PROVIDER_ERROR', {
      ...(failure?.status === 'rejected' ? { cause: failure.reason } : {}),
    })
  }
  const unique = [...new Map(addresses.map(row => [`${row.family}:${row.address}`, row])).values()]
  return assertPublicAddresses(hostname, unique)
}

/**
 * Reject an empty, mixed, or non-public DNS answer before a socket can use it.
 * @param hostname - Original URL host used in the structured error.
 * @param resolved - Complete DNS answer set to validate atomically.
 * @returns The unchanged validated address set.
 */
export function assertPublicAddresses(
  hostname: string,
  resolved: readonly ResolvedAddress[],
): readonly ResolvedAddress[] {
  if (resolved.length === 0 || resolved.some(row => !isPublicNetworkAddress(row.address))) {
    throw blocked(hostname)
  }
  return resolved
}

/**
 * Resolve once, reject mixed or private results, and return the exact addresses a socket may use.
 * @param hostname - URL hostname or IP literal to resolve and validate.
 * @param seams - Optional deterministic DNS and fetch seams used by tests and constrained hosts.
 * @returns Exact public address set that the transport must pin.
 */
export async function resolvePublicAddresses(
  hostname: string,
  seams: NetworkResolverSeams = {},
): Promise<readonly ResolvedAddress[]> {
  const unwrapped = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  const literalFamily = isIP(unwrapped)
  if (literalFamily !== 0) {
    if (!isPublicNetworkAddress(unwrapped)) throw blocked(hostname)
    return [{ address: unwrapped, family: literalFamily as 4 | 6 }]
  }
  let resolved: ResolvedAddress[]
  try {
    resolved = await (seams.lookup ?? lookup)(unwrapped, { all: true, order: 'verbatim' }) as ResolvedAddress[]
  } catch (error: unknown) {
    throw new WebError(`cannot resolve URL host ${hostname}`, 'WEB_PROVIDER_ERROR', { cause: error })
  }
  if (resolved.length > 0 && resolved.every(row => isSyntheticProxyAddress(row.address))) {
    return await resolveSyntheticProxyHostname(unwrapped, seams.fetch ?? globalThis.fetch)
  }
  return assertPublicAddresses(hostname, resolved)
}

/**
 * Build a socket lookup that can return only the already validated DNS result.
 * @param addresses - Public addresses produced by `resolvePublicAddresses`.
 * @returns Node lookup function that never performs a second DNS query.
 */
export function pinnedLookup(addresses: readonly ResolvedAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    if (addresses.length === 0) {
      const error = Object.assign(new Error('no validated public address'), { code: 'ENOTFOUND' })
      callback(error, '', 0)
      return
    }
    if (options.all === true) {
      callback(null, addresses.map(row => ({ ...row })))
      return
    }
    const requestedFamily = options.family === 4 || options.family === 6 ? options.family : undefined
    const selected = addresses.find(row => requestedFamily === undefined || row.family === requestedFamily)
    if (selected === undefined) {
      const error = Object.assign(new Error('validated address family is unavailable'), { code: 'EAI_ADDRFAMILY' })
      callback(error, '', 0)
      return
    }
    callback(null, selected.address, selected.family)
  }
}
