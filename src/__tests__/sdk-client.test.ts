import { GenerateAssistantResponseCommand } from '@aws/codewhisperer-streaming-client'
import { describe, expect, test } from 'bun:test'
import { clearSdkClientCache, createSdkClient } from '../plugin/sdk-client'
import type { KiroAuthDetails } from '../plugin/types'

function auth(): KiroAuthDetails {
  return {
    refresh: 'refresh-token',
    access: 'access-token',
    expires: Date.now() + 3600000,
    authMethod: 'idc',
    region: 'us-east-1',
    email: 'user@example.com'
  }
}

async function captureRequest(client: ReturnType<typeof createSdkClient>) {
  let capturedRequest: any

  client.middlewareStack.add(
    () => async (args: any) => {
      capturedRequest = args.request
      throw new Error('captured-request')
    },
    { step: 'finalizeRequest', name: 'captureRequest', priority: 'high' }
  )

  const command = new GenerateAssistantResponseCommand({
    conversationState: {
      chatTriggerType: 'MANUAL',
      conversationId: 'test-conversation',
      currentMessage: {
        userInputMessage: {
          content: 'hello',
          modelId: 'claude-opus-4.7',
          origin: 'AI_EDITOR'
        }
      }
    }
  })

  await client.send(command).catch((error) => {
    if (error.message !== 'captured-request') throw error
  })

  const bodyText =
    typeof capturedRequest.body === 'string'
      ? capturedRequest.body
      : Buffer.from(capturedRequest.body).toString('utf8')

  return {
    body: JSON.parse(bodyText),
    request: { headers: capturedRequest.headers, bodyText }
  }
}

describe('SDK client', () => {
  test('uses Kiro CLI-style standard SDK retries for throttling', async () => {
    clearSdkClientCache()

    const client = createSdkClient(auth(), 'us-east-1')

    expect(await client.config.maxAttempts()).toBe(3)
    const retryMode = client.config.retryMode
    expect(typeof retryMode === 'function' ? await retryMode() : retryMode).toBe('standard')

    clearSdkClientCache()
  })

  test('injects effort before content-length is computed', async () => {
    clearSdkClientCache()

    const client = createSdkClient(auth(), 'us-east-1', 'max')
    const { body, request } = await captureRequest(client)

    expect(body.additionalModelRequestFields.output_config.effort).toBe('max')
    expect(Number(request.headers['content-length'])).toBe(Buffer.byteLength(request.bodyText))

    clearSdkClientCache()
  })

  test('omits additionalModelRequestFields when no effort is set', async () => {
    clearSdkClientCache()

    const client = createSdkClient(auth(), 'us-east-1')
    const { body } = await captureRequest(client)

    expect(body.additionalModelRequestFields).toBeUndefined()

    clearSdkClientCache()
  })

  test('injects xhigh, the level that was previously unreachable', async () => {
    clearSdkClientCache()

    const client = createSdkClient(auth(), 'us-east-1', 'xhigh')
    const { body, request } = await captureRequest(client)

    expect(body.additionalModelRequestFields.output_config.effort).toBe('xhigh')
    expect(Number(request.headers['content-length'])).toBe(Buffer.byteLength(request.bodyText))

    clearSdkClientCache()
  })

  test('does not reuse a cached client across different effort levels', () => {
    clearSdkClientCache()

    const max = createSdkClient(auth(), 'us-east-1', 'max')
    const xhigh = createSdkClient(auth(), 'us-east-1', 'xhigh')
    const maxAgain = createSdkClient(auth(), 'us-east-1', 'max')

    expect(xhigh).not.toBe(max)
    expect(maxAgain).toBe(max)

    clearSdkClientCache()
  })

  // Kiro validates the Kiro IDE identity via User-Agent; the SDK's built-in
  // user-agent middleware would otherwise overwrite it with an aws-sdk-js UA
  // that Kiro rejects (403 "subscription does not support this application").
  test('sends the Kiro IDE User-Agent, not the aws-sdk-js default', async () => {
    clearSdkClientCache()

    const client = createSdkClient(auth(), 'us-east-1')
    const { request } = await captureRequest(client)

    expect(request.headers['user-agent']).toBe('KiroIDE')
    expect(request.headers['x-amz-user-agent']).toBe('KiroIDE')
    expect(String(request.headers['user-agent'])).not.toContain('codewhispererstreaming')
    expect(request.headers['x-amzn-kiro-agent-mode']).toBe('vibe')

    clearSdkClientCache()
  })

  test('caches separately per proxy url', () => {
    clearSdkClientCache()

    const direct = createSdkClient(auth(), 'us-east-1')
    const proxied = createSdkClient(auth(), 'us-east-1', undefined, 'http://127.0.0.1:7890')
    const directAgain = createSdkClient(auth(), 'us-east-1')

    expect(proxied).not.toBe(direct)
    expect(directAgain).toBe(direct)

    clearSdkClientCache()
  })
})
