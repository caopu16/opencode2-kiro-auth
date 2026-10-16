import type { AccountRepository } from '../../infrastructure/database/account-repository.js'
import { RegionSchema } from '../../plugin/config/schema.js'
import * as logger from '../../plugin/logger.js'
import { summarizeUsage } from '../../plugin/usage.js'
import { UsageTracker } from '../account/usage-tracker.js'
import { IdcAuthMethod } from './idc-auth-method.js'
import { TokenRefresher } from './token-refresher.js'

type ToastFunction = (message: string, variant: 'info' | 'warning' | 'success' | 'error') => void

export class AuthHandler {
  private accountManager?: any
  private startupUsageFetched = false

  constructor(
    private config: any,
    private repository: AccountRepository
  ) {}

  async initialize(showToast?: ToastFunction): Promise<void> {
    const { syncFromKiroCli } = await import('../../plugin/sync/kiro-cli.js')

    logger.log('Auth init', { autoSyncKiroCli: !!this.config.auto_sync_kiro_cli })
    if (this.config.auto_sync_kiro_cli) {
      logger.log('Kiro CLI sync: start')
      await syncFromKiroCli()
      this.repository.invalidateCache()
      const accounts = await this.repository.findAll()
      if (this.accountManager) {
        for (const a of accounts) this.accountManager.addAccount(a)
      }
      logger.log('Kiro CLI sync: done', { importedAccounts: accounts.length })
    }

    // Refresh usage before the summary toast: the persisted value is stale after
    // the monthly reset until the first request syncs. Backgrounded so it never
    // delays the auth loader, and falls back to the stored value on error.
    void (async () => {
      try {
        await this.refreshUsageFromApi(showToast)
      } catch (e) {
        logger.warn('Startup usage refresh failed', {
          error: e instanceof Error ? e.message : String(e)
        })
      }
      this.logUsageSummary(showToast)
    })()
  }

  async refreshUsageFromApi(showToast?: ToastFunction): Promise<void> {
    if (!this.accountManager || this.config.usage_tracking_enabled === false) return
    if (this.startupUsageFetched) return
    this.startupUsageFetched = true

    const { syncFromKiroCli } = await import('../../plugin/sync/kiro-cli.js')
    const tokenRefresher = new TokenRefresher(
      this.config,
      this.accountManager,
      syncFromKiroCli,
      this.repository
    )
    const usageTracker = new UsageTracker(this.config, this.accountManager, this.repository)
    const toast: ToastFunction = showToast ?? (() => {})

    for (const acc of this.accountManager.getAccounts()) {
      if (!acc.isHealthy) continue
      try {
        const { account: usable } = await tokenRefresher.refreshIfNeeded(
          acc,
          this.accountManager.toAuthDetails(acc),
          toast
        )
        if (!usable.isHealthy) continue
        await usageTracker.syncNow(usable, this.accountManager.toAuthDetails(usable))
      } catch (e) {
        logger.warn('Startup usage fetch failed; keeping stored value', {
          email: acc.email,
          error: e instanceof Error ? e.message : String(e)
        })
      }
    }
  }

  private logUsageSummary(showToast?: ToastFunction): void {
    if (!this.accountManager) return
    const accounts = this.accountManager.getAccounts()
    if (!accounts.length) return

    for (const acc of accounts) {
      const { used, limit, pct } = summarizeUsage(acc.usedCount ?? 0, acc.limitCount ?? 0)
      if (limit > 0) {
        const msg = `Kiro usage (${acc.email}): ${used}/${limit} (${pct}%)`
        logger.log(msg)
        if (showToast) {
          const variant = pct >= 90 ? 'warning' : 'info'
          setTimeout(() => showToast(msg, variant), 3000)
        }
      } else if (used > 0) {
        const msg = `Kiro usage (${acc.email}): ${used} requests used`
        logger.log(msg)
        if (showToast) setTimeout(() => showToast(msg, 'info'), 3000)
      }
    }
  }

  setAccountManager(am: any): void {
    this.accountManager = am
  }

  /**
   * OAuth methods in OpenCode v2 integration form. Validation that v1 did per prompt
   * now happens in authorize(), since v2 forms only support declarative checks.
   */
  getIntegrationMethods(integrationID: string): any[] {
    if (!this.accountManager) return []

    const idcMethod = new IdcAuthMethod(this.config, this.repository, this.accountManager)
    const configStartUrl = this.config.idc_start_url
    const configRegion = this.config.idc_region
    const configProfileArn = this.config.idc_profile_arn

    const startUrlField = {
      type: 'string',
      key: 'start_url',
      title: 'IAM Identity Center Start URL',
      description: configStartUrl
        ? 'Current: ' + configStartUrl + ' (leave blank to keep)'
        : 'Leave blank for AWS Builder ID',
      placeholder: 'https://your-company.awsapps.com/start',
      format: 'uri'
    }
    const regionField = {
      type: 'string',
      key: 'idc_region',
      title: 'IAM Identity Center region (sso_region)',
      description:
        configRegion && configRegion !== 'us-east-1'
          ? 'Current: ' + configRegion + ' (leave blank to keep)'
          : 'Leave blank for us-east-1',
      placeholder: 'us-east-1'
    }
    const profileArnField = {
      type: 'string',
      key: 'profile_arn',
      title: 'Profile ARN',
      description: configProfileArn
        ? 'Current: ' + configProfileArn + ' (leave blank to keep)'
        : 'e.g. arn:aws:codewhisperer:eu-central-1:428597928572:profile/HE7XVERQ9VXW',
      placeholder: 'arn:aws:codewhisperer:us-east-1:123456789012:profile/XXXXXXXXXX',
      required: !configProfileArn
    }

    const authorize = (requireProfileArn: boolean) => async (answer: Record<string, unknown>) => {
      const inputs: Record<string, string> = {}
      for (const [key, value] of Object.entries(answer ?? {})) {
        if (typeof value === 'string' && value.trim()) inputs[key] = value.trim()
      }
      validateIdcInputs(inputs, requireProfileArn && !configProfileArn)
      return idcMethod.authorize(inputs, requireProfileArn ? 'idc-profile' : 'idc')
    }

    return [
      {
        integrationID,
        method: {
          id: 'idc',
          type: 'oauth',
          label: 'AWS Builder ID / IAM Identity Center',
          form: [startUrlField, regionField]
        },
        authorize: authorize(false),
        label: () => 'Kiro'
      },
      {
        integrationID,
        method: {
          id: 'idc-profile',
          type: 'oauth',
          label: 'IAM Identity Center with Profile ARN',
          form: [startUrlField, regionField, profileArnField]
        },
        authorize: authorize(true),
        label: () => 'Kiro'
      }
    ]
  }
}

export function validateIdcInputs(inputs: Record<string, string>, requireProfileArn: boolean): void {
  if (inputs.start_url) {
    try {
      new URL(inputs.start_url)
    } catch {
      throw new Error('Please enter a valid URL for the IAM Identity Center Start URL')
    }
  }
  if (inputs.idc_region && !RegionSchema.safeParse(inputs.idc_region).success) {
    throw new Error('Please enter a valid AWS region')
  }
  const arn = inputs.profile_arn
  if (!arn && requireProfileArn) throw new Error('Profile ARN is required for this method')
  if (arn && !arn.startsWith('arn:aws:codewhisperer:') && !arn.startsWith('arn:aws:qdeveloper:')) {
    throw new Error('Please enter a valid CodeWhisperer or Q Developer profile ARN')
  }
}
