import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getSdkProxyAgent, resolveProxyUrl } from '../plugin/proxy'

const PROXY_ENV_KEYS = [
  'HTTPS_PROXY',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
  'HTTP_PROXY',
  'http_proxy'
] as const

describe('resolveProxyUrl', () => {
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const k of PROXY_ENV_KEYS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  })

  afterEach(() => {
    for (const k of PROXY_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  test('prefers an explicit config value over the environment', () => {
    process.env.HTTPS_PROXY = 'http://env-proxy:8080'
    expect(resolveProxyUrl('http://config-proxy:7890')).toBe('http://config-proxy:7890')
  })

  test('falls back to HTTPS_PROXY when config is empty', () => {
    process.env.HTTPS_PROXY = 'http://env-proxy:8080'
    expect(resolveProxyUrl()).toBe('http://env-proxy:8080')
    expect(resolveProxyUrl('')).toBe('http://env-proxy:8080')
    expect(resolveProxyUrl('   ')).toBe('http://env-proxy:8080')
  })

  test('honors the ALL_PROXY / HTTP_PROXY fallbacks in order', () => {
    process.env.ALL_PROXY = 'http://all-proxy:1080'
    expect(resolveProxyUrl()).toBe('http://all-proxy:1080')
    delete process.env.ALL_PROXY
    process.env.HTTP_PROXY = 'http://http-proxy:3128'
    expect(resolveProxyUrl()).toBe('http://http-proxy:3128')
  })

  test('returns undefined for a direct connection when nothing is set', () => {
    expect(resolveProxyUrl()).toBeUndefined()
  })

  test('treats "direct" as an explicit opt-out', () => {
    process.env.HTTPS_PROXY = 'http://env-proxy:8080'
    expect(resolveProxyUrl('direct')).toBeUndefined()
    expect(resolveProxyUrl('DIRECT')).toBeUndefined()
  })
})

describe('getSdkProxyAgent', () => {
  test('returns undefined without a proxy (direct connection)', () => {
    expect(getSdkProxyAgent('direct')).toBeUndefined()
  })

  test('builds an agent for a valid proxy url', () => {
    const agent = getSdkProxyAgent('http://127.0.0.1:7890')
    expect(agent).toBeDefined()
  })

  test('ignores an invalid proxy url and connects directly', () => {
    expect(getSdkProxyAgent('not-a-url')).toBeUndefined()
  })
})
