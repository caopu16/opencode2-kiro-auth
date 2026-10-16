import { HttpsProxyAgent } from 'https-proxy-agent'
import type { Agent as HttpAgent } from 'node:http'
import * as logger from './logger'

/**
 * Kiro's API rejects requests that do not originate from an accepted region.
 * The AWS SDK (`@aws/codewhisperer-streaming-client`) and Node's global `fetch`
 * both ignore the system proxy and connect directly, so without an explicit
 * proxy the direct egress IP is used and Kiro returns 400 "Invalid model" or
 * 403 "subscription does not support this application".
 *
 * This module resolves a single proxy URL and builds the two client-specific
 * primitives that force traffic through it:
 *   - an https.Agent (via https-proxy-agent) for the AWS SDK's NodeHttpHandler
 *   - an undici ProxyAgent dispatcher for `fetch`
 *
 * Resolution order:
 *   1. explicit `proxy_url` config value
 *   2. HTTPS_PROXY / https_proxy / ALL_PROXY / all_proxy / HTTP_PROXY / http_proxy
 *   3. none (direct connection)
 * The literal string "direct" (config or env) disables proxying.
 */

let warnedInvalid = false

// Module-level proxy configuration, set once at plugin init so fetch-based
// callers (token refresh, usage, web search) can share one dispatcher without
// threading proxy_url through every signature.
let configuredProxyUrl: string | undefined
let cachedDispatcher: unknown | undefined
let dispatcherResolvedFor: string | undefined | null = null

/**
 * Record the resolved proxy URL for fetch-based Kiro calls. Call once during
 * plugin setup with the loaded config value.
 */
export function initProxy(configProxyUrl?: string): void {
  configuredProxyUrl = configProxyUrl
  // Reset any cached dispatcher so the next kiroFetch rebuilds it.
  cachedDispatcher = undefined
  dispatcherResolvedFor = null
}

function normalize(value: string | undefined): string | undefined {
  const v = value?.trim()
  return v && v.length > 0 ? v : undefined
}

export function resolveProxyUrl(configProxyUrl?: string): string | undefined {
  const configured = normalize(configProxyUrl)
  if (configured) {
    return configured.toLowerCase() === 'direct' ? undefined : configured
  }

  const env =
    normalize(process.env.HTTPS_PROXY) ||
    normalize(process.env.https_proxy) ||
    normalize(process.env.ALL_PROXY) ||
    normalize(process.env.all_proxy) ||
    normalize(process.env.HTTP_PROXY) ||
    normalize(process.env.http_proxy)

  if (env) {
    return env.toLowerCase() === 'direct' ? undefined : env
  }

  return undefined
}

function isValidProxyUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * https.Agent that tunnels through the resolved proxy, for the AWS SDK's
 * NodeHttpHandler ({ httpsAgent }). Returns undefined for a direct connection.
 */
export function getSdkProxyAgent(configProxyUrl?: string): HttpAgent | undefined {
  const url = resolveProxyUrl(configProxyUrl)
  if (!url) return undefined
  if (!isValidProxyUrl(url)) {
    if (!warnedInvalid) {
      warnedInvalid = true
      logger.warn(`Ignoring invalid proxy_url "${url}" (expected http:// or https://)`)
    }
    return undefined
  }
  return new HttpsProxyAgent(url) as unknown as HttpAgent
}

/**
 * undici ProxyAgent dispatcher for global `fetch`, so token refresh, usage, and
 * web-search calls route through the same proxy. Returns undefined for a direct
 * connection. undici is loaded dynamically because it is only needed when a
 * proxy is configured.
 */
export async function getFetchProxyDispatcher(
  configProxyUrl?: string
): Promise<unknown | undefined> {
  const url = resolveProxyUrl(configProxyUrl)
  if (!url) return undefined
  if (!isValidProxyUrl(url)) {
    if (!warnedInvalid) {
      warnedInvalid = true
      logger.warn(`Ignoring invalid proxy_url "${url}" (expected http:// or https://)`)
    }
    return undefined
  }
  try {
    const { ProxyAgent } = await import('undici')
    return new ProxyAgent(url)
  } catch (error) {
    logger.warn(`Failed to create fetch proxy dispatcher for "${url}": ${String(error)}`)
    return undefined
  }
}

/**
 * fetch() wrapper that routes Kiro API calls through the configured proxy
 * (set via initProxy). The AWS SDK path is handled separately in sdk-client;
 * this covers token refresh, usage, and web search. When no proxy is
 * configured it behaves like a plain fetch. The dispatcher is built lazily and
 * cached per resolved URL.
 */
export async function kiroFetch(
  input: string | URL,
  init?: Record<string, unknown>
): Promise<Response> {
  const resolved = resolveProxyUrl(configuredProxyUrl)

  if (resolved && dispatcherResolvedFor !== resolved) {
    cachedDispatcher = await getFetchProxyDispatcher(configuredProxyUrl)
    dispatcherResolvedFor = resolved
  } else if (!resolved) {
    cachedDispatcher = undefined
    dispatcherResolvedFor = null
  }

  const finalInit = cachedDispatcher
    ? { ...(init ?? {}), dispatcher: cachedDispatcher }
    : init

  return fetch(input as any, finalInit as any)
}
