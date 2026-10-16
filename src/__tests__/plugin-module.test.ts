import { describe, expect, test } from 'bun:test'
import pluginModule from '../index.js'
import { applyBodyOverlay, buildModelInfos } from '../plugin.js'

describe('package plugin module', () => {
  test('default export is an OpenCode v2 plugin definition with the kiro id', () => {
    expect(pluginModule.id).toBe('kiro')
    expect(typeof pluginModule.setup).toBe('function')
  })

  test('advertises models as v2 Model.Info with thinking variants', () => {
    const models = buildModelInfos('kiro')
    const opus = models.find((m) => m.id === 'claude-opus-5-5-thinking')
    expect(opus?.providerID).toBe('kiro')
    expect(opus?.variants.map((v: any) => v.id)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(opus?.variants[0].body).toEqual({ thinkingConfig: { thinkingBudget: 16384 } })
  })

  test('merges variant body overlays into the JSON request body', () => {
    const init = applyBodyOverlay({ body: JSON.stringify({ model: 'x', a: { b: 1 } }) }, { a: { c: 2 } })
    expect(JSON.parse(init?.body as string)).toEqual({ model: 'x', a: { b: 1, c: 2 } })
  })
})
