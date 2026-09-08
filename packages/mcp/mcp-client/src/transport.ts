/**
 * Transport factory: creates the appropriate MCP transport based on the
 * plugin's resolved config. Stdio spawns a child process (with credential
 * scrubbing); Streamable HTTP connects to a URL.
 *
 * @module
 */

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './index.ts'

/**
 * Resolve credential references into an ephemeral transport configuration.
 * @param ctx - Cordis context that may provide the credential service.
 * @param config - Persistent MCP config containing references, never resolved secrets.
 * @returns Detached transport config with resolved environment variables or headers.
 */
export async function resolveCredentialConfig(ctx: Context, config: Config): Promise<Config> {
  if (config.transport === 'stdio') {
    const bindings = Object.entries(config.envCredentials ?? {})
    if (bindings.length === 0) return config
    const credentials = ctx.get('credentials')
    if (credentials === undefined) throw new Error(`mcp-client(${config.serverName}): credential provider is absent`)
    const env = { ...config.env }
    for (const [name, refValue] of bindings) {
      if (Object.hasOwn(env, name)) {
        throw new Error(`mcp-client(${config.serverName}): env ${name} has both a literal and a credential binding`)
      }
      const ref = credentialRef(refValue)
      const resolved = await credentials.resolve(ref)
      if (resolved === undefined) throw new Error(`mcp-client(${config.serverName}): credential ${ref} is not configured`)
      env[name] = resolved.value
    }
    return { ...config, env, envCredentials: {} }
  }
  const bindings = Object.entries(config.headerCredentials ?? {})
  if (bindings.length === 0) return config
  const credentials = ctx.get('credentials')
  if (credentials === undefined) throw new Error(`mcp-client(${config.serverName}): credential provider is absent`)
  const headers = { ...config.headers }
  for (const [name, binding] of bindings) {
    if (Object.hasOwn(headers, name)) {
      throw new Error(`mcp-client(${config.serverName}): header ${name} has both a literal and a credential binding`)
    }
    const ref = credentialRef(binding.ref)
    const resolved = await credentials.resolve(ref)
    if (resolved === undefined) throw new Error(`mcp-client(${config.serverName}): credential ${ref} is not configured`)
    headers[name] = `${binding.prefix ?? ''}${resolved.value}`
  }
  return { ...config, headers, headerCredentials: {} }
}

/**
 * The subprocess seam's scrubbed parent env (credential-shaped and stale
 * `DSH_*` names dropped), plus the spec's explicit env. The MCP SDK owns the
 * actual spawn, so this transport shares the scrub definition rather than the
 * spawn path.
 */
function buildChildEnv(extra: Record<string, string>): Record<string, string> {
  return { ...scrubbedParentEnv(), ...extra }
}

/**
 * Create an MCP transport from the resolved plugin config.
 *
 * @param config - Resolved plugin config discriminated on `transport`.
 * @returns A connected-ready MCP Transport (stdio or Streamable HTTP).
 */
export function createTransport(config: Config): Transport {
  switch (config.transport) {
    case 'stdio':
      return new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: buildChildEnv(config.env),
        cwd: config.cwd,
      })
    case 'streamable-http':
      // The MCP SDK's StreamableHTTPClientTransport has optional callback
      // properties typed without `| undefined` (exactOptionalPropertyTypes
      // mismatch with the Transport interface); the SDK constructed the
      // object, so the cast records only that widening.
      return new StreamableHTTPClientTransport(
        new URL(config.url),
        { requestInit: { headers: config.headers } },
      ) as Transport
  }
}
