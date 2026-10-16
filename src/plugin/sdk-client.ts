import { CodeWhispererStreamingClient } from '@aws/codewhisperer-streaming-client'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import { KIRO_CONSTANTS } from '../constants.js'
import { getSdkProxyAgent } from './proxy'
import type { Effort, KiroAuthDetails } from './types'

/**
 * Cache key includes effort to ensure separate clients for different effort levels,
 * since middleware is configured at client creation time.
 */
interface ClientCacheEntry {
  client: CodeWhispererStreamingClient
  token: string
  effort?: Effort
  proxyUrl?: string
}

const clientCache = new Map<string, ClientCacheEntry>()
const KIRO_CLI_MAX_ATTEMPTS = 3

export function createSdkClient(
  auth: KiroAuthDetails,
  region: string,
  effort?: Effort,
  proxyUrl?: string
): CodeWhispererStreamingClient {
  const cacheKey = `${region}:${auth.email || 'default'}:${effort || 'none'}:${proxyUrl || 'direct'}`
  const cached = clientCache.get(cacheKey)

  if (cached && cached.token === auth.access && cached.effort === effort && cached.proxyUrl === proxyUrl) {
    return cached.client
  }

  const token = auth.access

  // Kiro validates the originating egress IP; the AWS SDK ignores the system
  // proxy and connects directly, so route it through the configured proxy
  // explicitly. Undefined agent => direct connection (unchanged behavior).
  const proxyAgent = getSdkProxyAgent(proxyUrl)

  const client = new CodeWhispererStreamingClient({
    region,
    endpoint: `https://q.${region}.amazonaws.com`,
    token: () => Promise.resolve({ token }),
    maxAttempts: KIRO_CLI_MAX_ATTEMPTS,
    retryMode: 'standard',
    customUserAgent: [[KIRO_CONSTANTS.USER_AGENT]],
    ...(proxyAgent ? { requestHandler: new NodeHttpHandler({ httpsAgent: proxyAgent }) } : {})
  })

  // The SDK's built-in user-agent middleware overwrites our User-Agent with
  // "aws-sdk-js/... codewhispererstreaming", which Kiro rejects with
  // 403 "subscription does not support this application". Remove it so the
  // Kiro IDE User-Agent we set below survives to the wire.
  try {
    client.middlewareStack.remove('getUserAgentMiddleware')
  } catch {
    // Middleware name may change across SDK versions; the explicit header set
    // below still applies, and the middleware (if present) would only override
    // it on older versions. Nothing actionable here.
  }

  // Add Kiro-specific headers and pin the Kiro IDE identity.
  client.middlewareStack.add(
    (next: any) => async (args: any) => {
      args.request.headers['x-amzn-kiro-agent-mode'] = 'vibe'
      args.request.headers['user-agent'] = KIRO_CONSTANTS.USER_AGENT
      args.request.headers['x-amz-user-agent'] = KIRO_CONSTANTS.USER_AGENT
      return next(args)
    },
    { step: 'build', name: 'addKiroHeaders' }
  )

  // Inject additionalModelRequestFields for effort-based thinking control
  if (effort) {
    client.middlewareStack.add(
      (next: any) => async (args: any) => {
        // The SDK serializes input to args.input, we need to modify the body
        // before it's sent. The body is in args.request.body as a string.
        if (args.request?.body) {
          try {
            const body = JSON.parse(args.request.body)
            body.additionalModelRequestFields = {
              output_config: {
                effort
              }
            }
            args.request.body = JSON.stringify(body)
          } catch {
            // If body parsing fails, continue without modification
          }
        }
        return next(args)
      },
      { step: 'build', name: 'addEffortConfig', priority: 'high' }
    )
  }

  clientCache.set(cacheKey, { client, token, effort, proxyUrl })
  return client
}

export function clearSdkClientCache(): void {
  for (const entry of clientCache.values()) {
    entry.client.destroy()
  }
  clientCache.clear()
}
