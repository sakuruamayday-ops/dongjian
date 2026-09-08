/** Independent Dongjian trust anchors; signing and packaged acceptance remain required. */

export const PRODUCT_TRUST_ANCHORS = Object.freeze({
  policyPublicKeySha256: 'e66d5e74faa29052963259b721365ce40500f2395a92e2f078865a48748f5ef1',
  skillBundlePublicKeySha256: 'e6b968ad3d33a8bbd9d7221a9ef347cb6152e682c124b93a97ba21d3aeab9dfc',
  skillBundleSigningTier: 'formal' as const,
  runtimePublicKeySha256: 'e66d5e74faa29052963259b721365ce40500f2395a92e2f078865a48748f5ef1',
  runtimeSigningTier: 'formal' as const,
  agentPresetRequiredFiles: Object.freeze([
    'agent.cordis.yml',
    'flash-routing-guidance.mjs',
    'preset.yml',
  ] as const),
})
