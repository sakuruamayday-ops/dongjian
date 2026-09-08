import { describe, expect, it } from 'vitest'
import { GONGCHUANG_REMOTE_CONTRIBUTIONS } from '../src/client/gongchuang-contributions.ts'

const PRODUCT_PACKAGES = [
  '@gongchuang/connectors',
  '@gongchuang/skill-marketplace',
  '@gongchuang/local-automation',
  '@gongchuang/graph-memory',
  '@gongchuang/account',
  '@gongchuang/model-connections',
] as const

describe('Gongchuang Remote assembly', () => {
  it('selects every product-owned generated contribution exactly once', () => {
    const mountedPackages = GONGCHUANG_REMOTE_CONTRIBUTIONS.map(contribution => contribution.package)

    expect(mountedPackages).toEqual(expect.arrayContaining([...PRODUCT_PACKAGES]))
    for (const packageName of PRODUCT_PACKAGES) {
      expect(mountedPackages.filter(candidate => candidate === packageName)).toHaveLength(1)
    }
    for (const contribution of GONGCHUANG_REMOTE_CONTRIBUTIONS) {
      expect(contribution.descriptors.length).toBeGreaterThan(0)
    }
  })
})
