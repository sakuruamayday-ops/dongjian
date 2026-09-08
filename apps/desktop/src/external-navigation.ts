import { BlockList, isIP } from 'node:net'

type LookupAddress = { readonly address: string; readonly family: number }
type LookupAll = (hostname: string) => Promise<readonly LookupAddress[]>

const blockedIpv4 = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blockedIpv4.addSubnet(network, prefix, 'ipv4')
const blockedIpv6 = new BlockList()
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['fc00::', 7], ['fe80::', 10],
  ['ff00::', 8], ['2001:db8::', 32],
] as const) blockedIpv6.addSubnet(network, prefix, 'ipv6')

const blockedNames = /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|example)$/iu

function publicAddress(address: string, family: number): boolean {
  if (family === 4 || isIP(address) === 4) return !blockedIpv4.check(address, 'ipv4')
  if (family === 6 || isIP(address) === 6) return !blockedIpv6.check(address, 'ipv6')
  return false
}

/** Resolve an external browser destination and reject local/private reachability. */
export async function validatePublicExternalUrl(
  value: string,
  lookupAll?: LookupAll,
): Promise<string> {
  let url: URL
  try { url = new URL(value) } catch { throw new Error('外部链接不是有效网址') }
  if (url.protocol !== 'https:') throw new Error('外部链接只允许 HTTPS')
  if (url.username !== '' || url.password !== '') throw new Error('外部链接不得包含账号信息')
  if (url.port !== '' && url.port !== '443') throw new Error('外部链接不得使用非标准端口')
  const hostname = url.hostname.replace(/\.$/u, '').toLowerCase()
  if (hostname === '' || blockedNames.test(hostname)) throw new Error('外部链接不得指向本机或内网名称')
  const literal = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname
  const literalFamily = isIP(literal)
  if (literalFamily !== 0 && !publicAddress(literal, literalFamily)) {
    throw new Error('外部链接不得直接指向本机、内网或保留地址')
  }
  // System browsers own DNS navigation. Optional resolution is retained for
  // callers that will themselves fetch the destination; resolving here by
  // default would reject public sites behind VPN/proxy fake-IP DNS ranges.
  if (literalFamily === 0 && lookupAll !== undefined) {
    const addresses = await lookupAll(hostname)
    if (addresses.length === 0 || addresses.some(entry => !publicAddress(entry.address, entry.family))) {
      throw new Error('外部链接不得指向本机、内网或保留地址')
    }
  }
  url.hostname = hostname
  return url.href
}

/** Fail closed; callers deliberately do not expose DNS details to the renderer. */
export async function openPublicExternal(
  value: string,
  open: (url: string) => Promise<void>,
  lookupAll?: LookupAll,
): Promise<boolean> {
  try {
    await open(await validatePublicExternalUrl(value, lookupAll))
    return true
  } catch {
    return false
  }
}
