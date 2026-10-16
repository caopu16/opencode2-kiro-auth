import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { Plugin } from '@opencode/plugin'
import { KIRO_CONSTANTS } from './constants.js'
import { AuthHandler } from './core/auth/auth-handler.js'
import { RequestHandler } from './core/request/request-handler.js'
import { AccountCache } from './infrastructure/database/account-cache.js'
import { AccountRepository } from './infrastructure/database/account-repository.js'
import { AccountManager } from './plugin/accounts.js'
import { loadConfig } from './plugin/config/index.js'
import * as logger from './plugin/logger.js'
import { initProxy } from './plugin/proxy.js'
import { buildModelRegistry } from './plugin/model-registry.js'
import { formatWebSearchResults, kiroWebSearch } from './plugin/web-search.js'

type ToastFunction = (message: string, variant: 'info' | 'warning' | 'success' | 'error') => void

export const KIRO_PROVIDER_ID = 'kiro'

// The description is adapted from Kiro's own web_search tool spec so the model
// gets the same guidance on when to search and how to attribute results.
const WEB_SEARCH_DESCRIPTION = [
  "Search the web using Kiro's built-in search engine. Returns titles, URLs, snippets, domains, and publish dates for a query. Billed as Kiro credits.",
  '',
  '## When to Use',
  '- The user asks for current or up-to-date information (pricing, versions, release notes, recent events, library APIs).',
  "- Verifying facts that may have changed recently, or details likely newer than the model's training data.",
  "- Looking up specifics of a library, framework, or tool that can't be reliably inferred from the codebase or context.",
  '',
  '## When NOT to Use',
  '- Basic concepts, historical facts, or well-established programming syntax the model already knows.',
  '- Anything answerable from the current repository, files, or conversation. Search the codebase first.',
  '',
  '## Query Tips',
  '- Keep queries focused; the query MUST be 200 characters or fewer (longer queries are rejected).',
  "- Rephrase the user's request into effective keywords. Run multiple focused searches for complex questions rather than one broad query.",
  '- The snippets often contain enough to answer directly; only fetch a full page (via a separate fetch tool) when you need more detail.',
  '',
  '## Using Results & Attribution',
  '- Prioritize the most recently published, authoritative sources (prefer official docs over blogs; use the domain to judge authority).',
  '- ALWAYS cite sources with inline links in the format [description](url).',
  '- Paraphrase and summarize; do not reproduce more than ~30 consecutive words verbatim from any single source. Preserve factual accuracy while condensing.'
].join('\n')

// OpenCode v2 has no toast API for server plugins, so surface messages in the plugin log.
const logToast: ToastFunction = (message, variant) => {
  if (variant === 'error') logger.error(message)
  else if (variant === 'warning') logger.warn(message)
  else logger.log(message)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function deepMerge(base: Record<string, unknown>, overlay: Record<string, unknown>) {
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(overlay)) {
    const current = out[key]
    out[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value
  }
  return out
}

/**
 * Merge model/variant body overlays (e.g. a thinking variant's thinkingConfig) into the
 * JSON request body. OpenCode's own fetch wrapper does this, but the Kiro fetch replaces it.
 */
export function applyBodyOverlay(init: RequestInit | undefined, overlay: unknown): RequestInit | undefined {
  if (!init || typeof init.body !== 'string' || !isPlainObject(overlay)) return init
  try {
    const parsed = JSON.parse(init.body)
    if (!isPlainObject(parsed)) return init
    return { ...init, body: JSON.stringify(deepMerge(parsed, overlay)) }
  } catch {
    return init
  }
}

/** Convert the plugin's registry entries into OpenCode v2 Model.Info records. */
export function buildModelInfos(providerID: string): any[] {
  const registry = buildModelRegistry() as Record<string, any>
  return Object.entries(registry).map(([id, spec]) => ({
    id,
    modelID: id,
    providerID,
    name: spec.name,
    capabilities: { tools: true, input: [...spec.modalities.input], output: ['text'] },
    variants: Object.entries(spec.variants ?? {}).map(([variant, body]) => ({ id: variant, body })),
    time: { released: 0 },
    cost: [],
    status: 'active',
    enabled: true,
    limit: { context: spec.limit.context, output: spec.limit.output }
  }))
}

export function createKiroPlugin(id: string): Plugin.Plugin {
  return {
    id,
    async setup(ctx) {
      const config = loadConfig(ctx.location.directory)

      // Force all Kiro API traffic (SDK inference + fetch-based token/usage/
      // web-search) through the configured proxy. The AWS SDK and Node fetch
      // otherwise connect directly, which Kiro rejects when the egress IP is
      // not an accepted region.
      initProxy(config.proxy_url)

      const repository = new AccountRepository(new AccountCache(60000))
      const authHandler = new AuthHandler(config, repository)
      const accountManager = await AccountManager.loadFromDisk(config.account_selection_strategy)
      authHandler.setAccountManager(accountManager)
      const requestHandler = new RequestHandler(accountManager, config, repository)

      // Kiro CLI sync + usage refresh. Not awaited so plugin startup is never blocked.
      void authHandler.initialize(logToast).catch((e) =>
        logger.warn('Auth init failed', { error: e instanceof Error ? e.message : String(e) })
      )

      const baseURL = KIRO_CONSTANTS.BASE_URL.replace('/generateAssistantResponse', '').replace(
        '{{region}}',
        config.default_region || 'us-east-1'
      )

      await ctx.provider.transform((editor) => {
        editor.add({
          info: {
            id,
            integrationID: id,
            name: 'Kiro',
            activation: 'enabled',
            // 'aisdk:' routes the provider through the AI SDK loader, which lets the
            // sdk hook below supply a client whose fetch talks to Kiro.
            package: 'aisdk:@ai-sdk/openai-compatible',
            settings: { baseURL }
          } as any,
          models: buildModelInfos(id)
        })
      })

      await ctx.aisdk.hook(
        'sdk',
        (event) => {
          const options = event.options
          event.sdk = createOpenAICompatible({
            name: id,
            baseURL: typeof options.baseURL === 'string' ? options.baseURL : baseURL,
            apiKey: 'kiro',
            headers: options.headers,
            fetch: ((input: any, init?: RequestInit) =>
              requestHandler.handle(input, applyBodyOverlay(init, options.body), logToast)) as any
          })
        },
        { providerID: id }
      )

      await ctx.integration.transform((editor) => {
        editor.update(id, (integration) => {
          integration.name = 'Kiro'
        })
        for (const registration of authHandler.getIntegrationMethods(id)) {
          editor.method.update(registration as any)
        }
      })

      const account = accountManager.getCurrentOrNext()
      if (config.web_search_enabled && account?.profileArn) {
        await ctx.tool.transform((editor) => {
          editor.add({
            name: 'kiro_web_search',
            description: WEB_SEARCH_DESCRIPTION,
            input: {
              type: 'object',
              properties: {
                query: { type: 'string', description: 'The search query. Must be 200 characters or fewer.' }
              },
              required: ['query'],
              additionalProperties: false
            } as any,
            async execute(input: any) {
              try {
                const results = await kiroWebSearch(accountManager, String(input?.query ?? ''))
                return { content: formatWebSearchResults(results) }
              } catch (e) {
                return { content: 'Web search failed: ' + (e instanceof Error ? e.message : String(e)) }
              }
            }
          })
        })
      }
    }
  }
}

export const KiroOAuthPlugin = createKiroPlugin(KIRO_PROVIDER_ID)
