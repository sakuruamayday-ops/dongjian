/** DNS-pinned HTTPS transport for third-party skill repositories. */

import type { IncomingHttpHeaders } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { LookupFunction } from 'node:net'
import {
  pinnedRepositoryLookup, resolvePublicRepositoryAddresses,
  type ResolvedAddress,
} from './repository-network-policy.ts'

/**
 * Data contract for repository https response.
 */
export interface RepositoryHttpsResponse {
  readonly status: number
  readonly headers: Readonly<Record<string, string | undefined>>
  readonly bytes: Uint8Array
}

/**
 * Data contract for repository https seams.
 */
export interface RepositoryHttpsSeams {
  readonly resolve?: (hostname: string) => Promise<readonly ResolvedAddress[]>
  readonly request?: typeof httpsRequest
  readonly lookup?: (addresses: readonly ResolvedAddress[]) => LookupFunction
}

function normalizedHeaders(headers: IncomingHttpHeaders): Readonly<Record<string, string | undefined>> {
  const result: Record<string, string | undefined> = {}
  for (const [name, value] of Object.entries(headers)) {
    result[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value
  }
  return Object.freeze(result)
}

/**
 * Fetch one HTTPS response after resolving every address and rejecting the
 * whole answer set if any address is not public. The socket lookup is then
 * pinned to that exact set, closing the DNS-rebinding window.
 * @param url - The url value.
 * @param headers - The headers value.
 * @param maxBytes - The max bytes value.
 * @param label - The label value.
 * @param seams - The seams value.
 * @returns The fetch pinned repository bytes result.
 */
export async function fetchPinnedRepositoryBytes(
  url: URL,
  headers: Readonly<Record<string, string>>,
  maxBytes: number,
  label: string,
  seams: RepositoryHttpsSeams = {},
): Promise<RepositoryHttpsResponse> {
  const addresses = await (seams.resolve ?? resolvePublicRepositoryAddresses)(url.hostname)
  const requester = seams.request ?? httpsRequest
  const lookup = (seams.lookup ?? pinnedRepositoryLookup)(addresses)

  return await new Promise<RepositoryHttpsResponse>((resolve, reject) => {
    let settled = false
    let total = 0
    const chunks: Buffer[] = []
    const rejectOnce = (error: Error): void => {
      if (settled) return
      settled = true
      reject(error)
    }
    const request = requester(url, {
      method: 'GET', headers, lookup, agent: false,
    }, (response) => {
      const declared = Number(response.headers['content-length'] ?? '0')
      if (Number.isFinite(declared) && declared > maxBytes) {
        response.resume()
        rejectOnce(new Error(`${label}超过大小上限`))
        request.destroy()
        return
      }
      response.on('data', (chunk: Buffer | Uint8Array | string) => {
        if (settled) return
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        total += bytes.byteLength
        if (total > maxBytes) {
          rejectOnce(new Error(`${label}超过大小上限`))
          request.destroy()
          return
        }
        chunks.push(bytes)
      })
      response.on('end', () => {
        if (settled) return
        settled = true
        resolve({
          status: response.statusCode ?? 0,
          headers: normalizedHeaders(response.headers),
          bytes: new Uint8Array(Buffer.concat(chunks)),
        })
      })
      response.on('error', (error: Error) => { rejectOnce(error) })
    })
    request.setTimeout(30_000, () => { request.destroy(new Error(`${label}连接超时`)) })
    request.on('error', (error: Error) => { rejectOnce(error) })
    request.end()
  })
}
