import { describe, expect, it, vi } from 'vitest'
import { openPublicExternal, validatePublicExternalUrl } from '../src/external-navigation.ts'

const publicLookup = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }])

describe('desktop external navigation', () => {
  it('opens only a resolved public HTTPS destination', async () => {
    const open = vi.fn(async () => undefined)
    await expect(openPublicExternal('https://agent.qcc.com/path', open, publicLookup)).resolves.toBe(true)
    expect(open).toHaveBeenCalledWith('https://agent.qcc.com/path')
  })

  it.each([
    'http://agent.qcc.com',
    'file:///tmp/secret',
    'javascript:alert(1)',
    'https://user:password@agent.qcc.com',
    'https://agent.qcc.com:8443',
    'https://localhost',
    'https://service.internal',
    'https://127.0.0.1',
    'https://10.1.2.3',
    'https://169.254.1.2',
    'https://[::1]',
    'https://[fc00::1]',
  ])('rejects unsafe destination %s', async (url) => {
    await expect(validatePublicExternalUrl(url, publicLookup)).rejects.toThrow()
  })

  it('rejects a public name when any DNS answer is private', async () => {
    await expect(validatePublicExternalUrl('https://mixed.example.cn', async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '192.168.1.5', family: 4 },
    ])).rejects.toThrow('不得指向本机、内网或保留地址')
  })

  it('does not call the system browser when validation fails', async () => {
    const open = vi.fn(async () => undefined)
    await expect(openPublicExternal('https://localhost', open, publicLookup)).resolves.toBe(false)
    expect(open).not.toHaveBeenCalled()
  })
})
