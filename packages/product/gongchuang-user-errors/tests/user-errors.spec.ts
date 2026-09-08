import { describe, expect, it } from 'vitest'
import { gongchuangDiagnostic, gongchuangUserError } from '../src/index.ts'

describe('gongchuang user errors', () => {
  it('distinguishes temporarily unreadable system credentials from invalid or missing model keys', () => {
    const error = new Error('gongchuang-credentials-keychain: macOS Keychain is temporarily unavailable')
    expect(gongchuangUserError(error, 'model')).toEqual({
      code: 'GC-MODEL-KEYCHAIN',
      message: '系统凭据暂不可用，请允许系统访问后重试',
      text: '系统凭据暂不可用，请允许系统访问后重试（诊断码：GC-MODEL-KEYCHAIN）',
    })
    expect(gongchuangUserError(error, 'account').code).toBe('GC-ACCOUNT-KEYCHAIN')
    expect(gongchuangUserError(new Error('MISSING_CREDENTIAL'), 'model').code).not.toBe('GC-MODEL-KEYCHAIN')
    expect(gongchuangUserError(new Error('invalid api key'), 'model').code).toBe('GC-MODEL-AUTH')
    expect(gongchuangUserError(new Error(gongchuangUserError(error, 'model').text), 'model').code)
      .toBe('GC-MODEL-KEYCHAIN')
  })

  it('never copies raw model errors, paths, credentials, stacks or causes into UI text', () => {
    const secret = 'sk-example-secret-1234567890'
    const cause = new Error(`401 upstream rejected ${secret} at /Users/example/private/config.json`)
    const error = new Error('Unauthorized', { cause })
    error.stack = 'Error: Unauthorized\n at /Users/example/app/main.ts:12:3'
    const presented = gongchuangUserError(error, 'model')
    expect(presented).toEqual({
      code: 'GC-MODEL-AUTH',
      message: 'API Key 无效或无权访问，请检查后重试',
      text: 'API Key 无效或无权访问，请检查后重试（诊断码：GC-MODEL-AUTH）',
    })
    expect(presented.text).not.toContain(secret)
    expect(presented.text).not.toContain('/Users/')
    expect(presented.text).not.toContain('Unauthorized')
  })

  it('distinguishes actionable account and model recovery categories', () => {
    expect(gongchuangUserError(Object.assign(new Error('upstream'), { status: 409 }), 'account').code)
      .toBe('GC-ACCOUNT-DEVICE')
    expect(gongchuangUserError(new Error('insufficient balance'), 'model').code)
      .toBe('GC-MODEL-BALANCE')
    expect(gongchuangUserError(new TypeError('fetch failed'), 'model').code)
      .toBe('GC-MODEL-NETWORK')
  })

  it('distinguishes workspace directory, permission, and settings failures', () => {
    expect(gongchuangUserError(new Error('企业空间根目录不可读写'), 'product', 'workspace').code)
      .toBe('GC-UI-WORKSPACE-PERMISSION')
    expect(gongchuangUserError(new Error('企业空间根目录必须是目录'), 'product', 'workspace').code)
      .toBe('GC-UI-WORKSPACE-DIRECTORY')
    expect(gongchuangUserError(new Error('企业空间根目录配置无法写入'), 'product', 'workspace').code)
      .toBe('GC-UI-WORKSPACE-CONFIG')
  })

  it('redacts credentials, authorization values and local paths from diagnostics', () => {
    const error = new Error(
      'Bearer top-secret token=abc123456 password=hunter2 '
      + 'sk-abcdefghijklmnop /Users/alice/project/config.json C:\\Users\\alice\\secret.txt '
      + 'https://api.example.com/v1?api_key=secret-value',
    )
    const diagnostic = gongchuangDiagnostic(error)
    expect(diagnostic).toContain('[redacted-credential]')
    expect(diagnostic).toContain('[local-path]')
    for (const forbidden of ['top-secret', 'abc123456', 'hunter2', 'abcdefghijklmnop', '/Users/alice', 'C:\\Users\\alice', 'secret-value']) {
      expect(diagnostic).not.toContain(forbidden)
    }
  })
})
