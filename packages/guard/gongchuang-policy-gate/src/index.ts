/**
 * Signed, fail-closed policy gate for the 洞见 desktop client.
 *
 * The desktop host signs the exact policy bytes. This native Cordis plugin
 * verifies those bytes synchronously at load, then intercepts every model
 * step and tool dispatch. No model prompt or compatibility hook is part of
 * the trust boundary.
 *
 * @module @gongchuang/client-policy-gate
 */

import { createHash, createPublicKey, verify } from 'node:crypto'
import { copyFileSync, existsSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/types'
import { preserveForkImports } from './fork-imports.ts'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { GONGCHUANG_MODEL_PROVIDERS } from '@gongchuang/model-connections/registry'
import {
  defineTool,
  type PostToolDecision,
  type PreToolDecision,
  type ToolExecution,
  type ToolExecutionResult,
} from '@deepseek-ai/dsh-tools'
import {
  normalizeProfessionalCandidate,
  professionalEvidenceNumberTokens,
  validateProfessionalCandidate,
  type ProfessionalCalculation,
  type ProfessionalEvidence,
} from './professional-validator.ts'
import {
  brandingRuntimeFromContracts,
  inspectProfessionalArtifact,
  inspectProfessionalBranding,
  professionalBrandIdentity,
  type ProfessionalArtifactInspection,
} from './artifact-validator.ts'
import {
  ProfessionalTaskCheckpointStore,
  type ProfessionalCheckpointPhase,
} from './task-checkpoint.ts'
import { userIntentText } from './annotation-intent.ts'
import { containsActionableAny, containsActionableMarker, isProvidedDataComparison, isUserRuleCalculation } from './professional-intent.ts'

/** Cordis loader name. */
export const name = 'gongchuang-policy-gate'

export {
  normalizeProfessionalCandidate,
  validateProfessionalCandidate,
  type ProfessionalCalculation,
  type ProfessionalCandidateInput,
  type ProfessionalCandidateResult,
  type ProfessionalEvidence,
} from './professional-validator.ts'

export {
  brandingRuntimeFromContracts,
  inspectProfessionalArtifact,
  inspectProfessionalBranding,
  professionalBrandIdentity,
  type ProfessionalArtifactFormat,
  type ProfessionalArtifactInspection,
  type ProfessionalBrandInspection,
} from './artifact-validator.ts'

export {
  ProfessionalTaskCheckpointStore,
  type ProfessionalCheckpointEnvelope,
  type ProfessionalCheckpointPhase,
  type ProfessionalCheckpointRead,
} from './task-checkpoint.ts'

/** The tool runtime owns the pre-dispatch interception seam. */
export const inject = ['tools']

/** Loader configuration. Every path and expected identity is mandatory. */
export interface Config {
  /** Exact signed policy manifest consumed before the agent is published. */
  manifestPath: string
  /** Canonical-base64 Ed25519 signature over the manifest bytes. */
  signaturePath: string
  /** PEM-encoded Ed25519 public key used to verify the manifest. */
  publicKeyPath: string
  /** SHA-256 of the public-key bytes compiled into the signed desktop host. */
  expectedPublicKeySha256: string
  /** Product identifier that the signed manifest must contain. */
  expectedProductId: string
  /** Desktop version that the signed manifest must contain. */
  expectedClientVersion: string
  /** Bundled skill version that the signed manifest must contain. */
  expectedSkillBundleVersion: string
  /** Skill version selected from the Host-verified bundle for this launch. */
  activeSkillBundleVersion: string
  /** Machine-readable professional delivery rules from the verified skill bundle. */
  professionalContractsPath: string
  /** Machine-readable dependency graph from the verified skill bundle. */
  skillCallGraphPath: string
  /** Host-owned private directory for resumable professional task state. */
  professionalCheckpointDir: string
  /** Fail-closed runtime fault used only by the desktop host's isolated acceptance mode. */
  acceptanceFaultMode?: 'pre-step'
}

/** Fail-loud schema; production composition may not silently default a trust anchor. */
export const Config: z<Config> = z.object({
  manifestPath: z.string().required(),
  signaturePath: z.string().required(),
  publicKeyPath: z.string().required(),
  expectedPublicKeySha256: z.string().required(),
  expectedProductId: z.string().required(),
  expectedClientVersion: z.string().required(),
  expectedSkillBundleVersion: z.string().required(),
  activeSkillBundleVersion: z.string().required(),
  professionalContractsPath: z.string().required(),
  skillCallGraphPath: z.string().required(),
  professionalCheckpointDir: z.string().required(),
  acceptanceFaultMode: z.union(['pre-step'] as const),
})

/** One business skill's deterministic routing and response-structure rules. */
export interface ProfessionalSkillRule {
  appliesWhenPromptContains: string[]
  queryMarkerGroups?: string[][]
  analysisMarkerGroups?: string[][]
  requiredMarkerGroups: string[][]
}

/** Host-derived answer depth for the current professional request. */
export type ProfessionalResponseDepth = 'query' | 'analysis' | 'formal'

/** Stable signed requirement ids used to distinguish formal blockers from advice. */
export type ProfessionalRequirementId =
  | 'required-sections'
  | 'required-tables'
  | 'artifact-format'
  | 'source-trace'
  | 'evidence-ledger'
  | 'peer-comparison'
  | 'policy-selection-trace'
  | 'four-question-review'

/** One required table declared by a signed professional delivery profile. */
export interface ProfessionalTableRule {
  id: string
  requiredColumns: readonly string[]
  minRows: number
}

/** One signed formal-delivery profile owned by a professional skill. */
export interface ProfessionalDeliveryProfile {
  skillId: string
  requiredSections: readonly string[]
  requiredTables: readonly ProfessionalTableRule[]
  artifactFormats: ReadonlySet<string>
  requiresSourceTrace: boolean
  requiresEvidenceLedger: boolean
  requiresPeerComparison: boolean
  requiresPolicySelectionTrace: boolean
  requiresFourQuestionReview: boolean
  criticalRequirements: ReadonlySet<ProfessionalRequirementId>
  advisoryRequirements: ReadonlySet<ProfessionalRequirementId>
}

/** Verified professional routing rules shipped inside the signed skill bundle. */
export interface ProfessionalContracts {
  ruleVersion: string
  businessDomainMarkers: string[]
  policyTaskMarkers: string[]
  peerTaskMarkers: string[]
  fourQuestionMarkerGroups: string[][]
  routeResolutionSkills: ReadonlySet<string>
  skills: ReadonlyMap<string, ProfessionalSkillRule>
  deliveryProfiles: ReadonlyMap<string, ProfessionalDeliveryProfile>
  dependencies: ReadonlyMap<string, readonly string[]>
  qualityGates: ReadonlyMap<string, readonly string[]>
}

/** Parsed fields covered by one product policy signature. */
export interface SignedPolicyManifest {
  schemaVersion: 1
  product: {
    id: string
    clientVersion: string
    skillBundleVersion: string
  }
  providers: { allow: string[] }
  tools: {
    allow: string[]
    ask: string[]
    deny: string[]
    allowUnattributed: boolean
  }
  executionBudgets: {
    search: SearchExecutionBudget
  }
  delivery: {
    professionalReceipt: DeliveryReceiptDefinition
    rules: DeliveryRule[]
  }
}

/** Signed ceiling for one product-launched联网检索 turn. */
export interface SearchExecutionBudget {
  triggerAny: string[]
  defaultTier: string
  tiers: SearchExecutionBudgetTier[]
}

/** One signed联网检索 ceiling selected from the current business risk. */
export interface SearchExecutionBudgetTier {
  id: string
  label: string
  triggerAny: string[]
  maxSteps: number
  maxSearchCalls: number
  maxFetchCalls: number
}

/** One required delivery receipt and the trusted tools allowed to produce it. */
export interface DeliveryReceiptDefinition {
  id: string
  label: string
  producerTools: string[]
}

/** Tool-trigger pattern and receipts required before a turn may complete. */
export interface DeliveryRule {
  id: string
  triggerAny: string[]
  receipts: DeliveryReceiptDefinition[]
}

/** Immutable verified policy plus audit digest of the signed bytes. */
export interface VerifiedPolicy {
  manifest: Readonly<SignedPolicyManifest>
  sha256: string
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string' || entry.length === 0)) {
    throw new Error(`gongchuang-policy-gate: ${field} must be an array of non-empty strings`)
  }
  return value.map((entry: unknown) => {
    if (typeof entry !== 'string') throw new Error(`gongchuang-policy-gate: ${field} contains a non-string value`)
    return entry
  })
}

function markerGroups(value: unknown, field: string): string[][] {
  if (!Array.isArray(value)) {
    throw new Error(`gongchuang-policy-gate: ${field} must be an array`)
  }
  return value.map((candidate, index) => stringArray(candidate, `${field}[${index}]`))
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`gongchuang-policy-gate: ${field} must be a boolean`)
  return value
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 0) {
    throw new Error(`gongchuang-policy-gate: ${field} must be a non-negative integer`)
  }
  return value
}

const PROFESSIONAL_REQUIREMENT_IDS = new Set<ProfessionalRequirementId>([
  'required-sections', 'required-tables', 'artifact-format', 'source-trace',
  'evidence-ledger', 'peer-comparison', 'policy-selection-trace', 'four-question-review',
])

function professionalRequirementSet(
  value: unknown,
  fallback: readonly ProfessionalRequirementId[],
  field: string,
): ReadonlySet<ProfessionalRequirementId> {
  const rows = value === undefined ? [...fallback] : stringArray(value, field)
  for (const row of rows) {
    if (!PROFESSIONAL_REQUIREMENT_IDS.has(row as ProfessionalRequirementId)) {
      throw new Error(`gongchuang-policy-gate: ${field} contains unknown requirement ${row}`)
    }
  }
  return new Set(rows as ProfessionalRequirementId[])
}

function deliveryProfiles(value: unknown): ReadonlyMap<string, ProfessionalDeliveryProfile> {
  const records = objectRecord(value)
  if (records === undefined) throw new Error('gongchuang-policy-gate: delivery profiles map is missing')
  const profiles = new Map<string, ProfessionalDeliveryProfile>()
  for (const [profileId, candidate] of Object.entries(records)) {
    const profile = objectRecord(candidate)
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(profileId) || profile === undefined
      || typeof profile.skill_id !== 'string' || profile.skill_id.length === 0
      || !Array.isArray(profile.required_tables) || !Array.isArray(profile.required_artifacts)) {
      throw new Error(`gongchuang-policy-gate: delivery profile ${profileId} is invalid`)
    }
    const tables = profile.required_tables.map((tableCandidate, index): ProfessionalTableRule => {
      const table = objectRecord(tableCandidate)
      if (table === undefined || typeof table.id !== 'string' || table.id.length === 0) {
        throw new Error(`gongchuang-policy-gate: delivery profile ${profileId} table ${String(index)} is invalid`)
      }
      return Object.freeze({
        id: table.id,
        requiredColumns: Object.freeze(stringArray(
          table.required_columns,
          `delivery_profiles.${profileId}.required_tables[${String(index)}].required_columns`,
        )),
        minRows: nonNegativeInteger(
          table.min_rows,
          `delivery_profiles.${profileId}.required_tables[${String(index)}].min_rows`,
        ),
      })
    })
    const formats = new Set<string>()
    for (const [index, artifactCandidate] of profile.required_artifacts.entries()) {
      const artifact = objectRecord(artifactCandidate)
      if (artifact === undefined) {
        throw new Error(`gongchuang-policy-gate: delivery profile ${profileId} artifact ${String(index)} is invalid`)
      }
      for (const format of stringArray(
        artifact.formats,
        `delivery_profiles.${profileId}.required_artifacts[${String(index)}].formats`,
      )) formats.add(format.toLowerCase())
    }
    const requiresSourceTrace = requiredBoolean(
      profile.requires_source_trace,
      `delivery_profiles.${profileId}.requires_source_trace`,
    )
    const requiresEvidenceLedger = requiredBoolean(
      profile.requires_evidence_ledger,
      `delivery_profiles.${profileId}.requires_evidence_ledger`,
    )
    const requiresPeerComparison = requiredBoolean(
      profile.requires_peer_comparison,
      `delivery_profiles.${profileId}.requires_peer_comparison`,
    )
    const requiresPolicySelectionTrace = requiredBoolean(
      profile.requires_policy_selection_trace,
      `delivery_profiles.${profileId}.requires_policy_selection_trace`,
    )
    const requiresFourQuestionReview = profile.requires_four_question_review === undefined
      ? false
      : requiredBoolean(
        profile.requires_four_question_review,
        `delivery_profiles.${profileId}.requires_four_question_review`,
      )
    const defaultCritical: ProfessionalRequirementId[] = [
      ...(stringArray(profile.required_sections, `delivery_profiles.${profileId}.required_sections`).length > 0
        ? ['required-sections' as const] : []),
      ...(tables.length > 0 ? ['required-tables' as const] : []),
      ...(formats.size > 0 ? ['artifact-format' as const] : []),
      ...(requiresSourceTrace ? ['source-trace' as const] : []),
      ...(requiresEvidenceLedger ? ['evidence-ledger' as const] : []),
      ...(requiresPeerComparison ? ['peer-comparison' as const] : []),
      ...(requiresPolicySelectionTrace ? ['policy-selection-trace' as const] : []),
    ]
    const criticalRequirements = professionalRequirementSet(
      profile.critical_requirements,
      defaultCritical,
      `delivery_profiles.${profileId}.critical_requirements`,
    )
    const advisoryRequirements = professionalRequirementSet(
      profile.advisory_requirements,
      requiresFourQuestionReview ? ['four-question-review'] : [],
      `delivery_profiles.${profileId}.advisory_requirements`,
    )
    if (defaultCritical.some(requirement => !criticalRequirements.has(requirement))) {
      throw new Error(`gongchuang-policy-gate: delivery profile ${profileId} weakens an enforced critical requirement`)
    }
    if ([...criticalRequirements].some(requirement => advisoryRequirements.has(requirement))) {
      throw new Error(`gongchuang-policy-gate: delivery profile ${profileId} assigns one requirement to two severities`)
    }
    profiles.set(profileId, Object.freeze({
      skillId: profile.skill_id,
      requiredSections: Object.freeze(stringArray(
        profile.required_sections,
        `delivery_profiles.${profileId}.required_sections`,
      )),
      requiredTables: Object.freeze(tables),
      artifactFormats: formats,
      requiresSourceTrace,
      requiresEvidenceLedger,
      requiresPeerComparison,
      requiresPolicySelectionTrace,
      requiresFourQuestionReview,
      criticalRequirements,
      advisoryRequirements,
    }))
  }
  return profiles
}

function parseJsonFile(path: string, label: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error: unknown) {
    throw new Error(`gongchuang-policy-gate: cannot load ${label}`, { cause: error })
  }
  const record = objectRecord(parsed)
  if (record === undefined) throw new Error(`gongchuang-policy-gate: ${label} must be a JSON object`)
  return record
}

/**
 * Load the professional routing and dependency contracts from the host-verified skill bundle.
 * @param config - Product identity plus immutable skill-bundle contract paths.
 * @returns Frozen professional rules whose version matches the active Host-verified skill suite.
 */
export function loadProfessionalContracts(config: Config): ProfessionalContracts {
  const delivery = parseJsonFile(config.professionalContractsPath, 'professional delivery contracts')
  const graph = parseJsonFile(config.skillCallGraphPath, 'skill call graph')
  if (delivery.schema_version !== 3 || delivery.rule_version !== config.activeSkillBundleVersion
    || graph.schema_version !== 1) {
    throw new Error('gongchuang-policy-gate: professional contract version mismatch')
  }
  const skillRecords = objectRecord(delivery.skills)
  if (skillRecords === undefined) throw new Error('gongchuang-policy-gate: professional skills map is missing')
  const skills = new Map<string, ProfessionalSkillRule>()
  for (const [name, candidate] of Object.entries(skillRecords)) {
    const rule = objectRecord(candidate)
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || rule === undefined) {
      throw new Error(`gongchuang-policy-gate: professional skill rule ${name} is invalid`)
    }
    const parsedRule = {
      appliesWhenPromptContains: stringArray(
        rule.applies_when_prompt_contains,
        `skills.${name}.applies_when_prompt_contains`,
      ),
      queryMarkerGroups: rule.query_marker_groups === undefined
        ? []
        : markerGroups(rule.query_marker_groups, `skills.${name}.query_marker_groups`),
      analysisMarkerGroups: rule.analysis_marker_groups === undefined
        ? []
        : markerGroups(rule.analysis_marker_groups, `skills.${name}.analysis_marker_groups`),
      requiredMarkerGroups: markerGroups(rule.required_marker_groups, `skills.${name}.required_marker_groups`),
    }
    Object.freeze(parsedRule.appliesWhenPromptContains)
    for (const group of parsedRule.queryMarkerGroups) Object.freeze(group)
    Object.freeze(parsedRule.queryMarkerGroups)
    for (const group of parsedRule.analysisMarkerGroups) Object.freeze(group)
    Object.freeze(parsedRule.analysisMarkerGroups)
    for (const group of parsedRule.requiredMarkerGroups) Object.freeze(group)
    Object.freeze(parsedRule.requiredMarkerGroups)
    skills.set(name, Object.freeze(parsedRule))
  }
  if (!Array.isArray(graph.relations)) throw new Error('gongchuang-policy-gate: skill call graph relations are missing')
  const mutableDependencies = new Map<string, string[]>()
  const mutableQualityGates = new Map<string, string[]>()
  for (const [index, candidate] of graph.relations.entries()) {
    const relation = objectRecord(candidate)
    if (relation === undefined || typeof relation.from !== 'string' || typeof relation.to !== 'string'
      || typeof relation.type !== 'string') {
      throw new Error(`gongchuang-policy-gate: skill call graph relation ${index} is invalid`)
    }
    if (relation.type !== 'requires' && relation.type !== 'quality_gate') continue
    const current = mutableDependencies.get(relation.from) ?? []
    if (!current.includes(relation.to)) current.push(relation.to)
    mutableDependencies.set(relation.from, current)
    if (relation.type === 'quality_gate') {
      const gates = mutableQualityGates.get(relation.from) ?? []
      if (!gates.includes(relation.to)) gates.push(relation.to)
      mutableQualityGates.set(relation.from, gates)
    }
  }
  const dependencies = new Map<string, readonly string[]>()
  for (const [name, rows] of mutableDependencies) dependencies.set(name, Object.freeze([...rows]))
  const qualityGates = new Map<string, readonly string[]>()
  for (const [name, rows] of mutableQualityGates) qualityGates.set(name, Object.freeze([...rows]))
  const result: ProfessionalContracts = {
    ruleVersion: delivery.rule_version,
    businessDomainMarkers: stringArray(delivery.business_domain_markers, 'business_domain_markers'),
    policyTaskMarkers: stringArray(delivery.policy_task_markers, 'policy_task_markers'),
    peerTaskMarkers: stringArray(delivery.peer_task_markers, 'peer_task_markers'),
    fourQuestionMarkerGroups: delivery.four_question_marker_groups === undefined
      ? []
      : markerGroups(delivery.four_question_marker_groups, 'four_question_marker_groups'),
    routeResolutionSkills: new Set(stringArray(delivery.route_resolution_skills, 'route_resolution_skills')),
    skills,
    deliveryProfiles: deliveryProfiles(delivery.delivery_profiles),
    dependencies,
    qualityGates,
  }
  Object.freeze(result.businessDomainMarkers)
  Object.freeze(result.policyTaskMarkers)
  Object.freeze(result.peerTaskMarkers)
  Object.freeze(result.fourQuestionMarkerGroups)
  return Object.freeze(result)
}

function deliveryRules(value: unknown): DeliveryRule[] {
  if (!Array.isArray(value)) {
    throw new Error('gongchuang-policy-gate: delivery.rules must be an array')
  }
  const ruleIds = new Set<string>()
  const receiptIds = new Set<string>()
  return value.map((candidate, ruleIndex) => {
    const rule = objectRecord(candidate)
    const field = `delivery.rules[${ruleIndex}]`
    if (rule === undefined || typeof rule.id !== 'string' || rule.id.length === 0
      || !Array.isArray(rule.receipts) || rule.receipts.length === 0) {
      throw new Error(`gongchuang-policy-gate: ${field} is incomplete`)
    }
    if (ruleIds.has(rule.id)) throw new Error(`gongchuang-policy-gate: duplicate delivery rule ${rule.id}`)
    ruleIds.add(rule.id)
    const receipts = rule.receipts.map((receiptCandidate, receiptIndex): DeliveryReceiptDefinition => {
      const receipt = objectRecord(receiptCandidate)
      const receiptField = `${field}.receipts[${receiptIndex}]`
      if (receipt === undefined || typeof receipt.id !== 'string' || receipt.id.length === 0
        || typeof receipt.label !== 'string' || receipt.label.length === 0) {
        throw new Error(`gongchuang-policy-gate: ${receiptField} is incomplete`)
      }
      if (receiptIds.has(receipt.id)) {
        throw new Error(`gongchuang-policy-gate: duplicate delivery receipt ${receipt.id}`)
      }
      receiptIds.add(receipt.id)
      return {
        id: receipt.id,
        label: receipt.label,
        producerTools: stringArray(receipt.producerTools, `${receiptField}.producerTools`),
      }
    })
    return {
      id: rule.id,
      triggerAny: stringArray(rule.triggerAny, `${field}.triggerAny`),
      receipts,
    }
  })
}

function deliveryReceipt(value: unknown, field: string): DeliveryReceiptDefinition {
  const receipt = objectRecord(value)
  if (receipt === undefined || typeof receipt.id !== 'string' || receipt.id.length === 0
    || typeof receipt.label !== 'string' || receipt.label.length === 0) {
    throw new Error(`gongchuang-policy-gate: ${field} is incomplete`)
  }
  return {
    id: receipt.id,
    label: receipt.label,
    producerTools: stringArray(receipt.producerTools, `${field}.producerTools`),
  }
}

function searchExecutionBudget(value: unknown): SearchExecutionBudget {
  const budget = objectRecord(value)
  if (budget === undefined) throw new Error('gongchuang-policy-gate: executionBudgets.search is missing')
  if (typeof budget.defaultTier !== 'string' || budget.defaultTier.length === 0 || !Array.isArray(budget.tiers)) {
    throw new Error('gongchuang-policy-gate: executionBudgets.search tier configuration is incomplete')
  }
  const ids = new Set<string>()
  const tiers = budget.tiers.map((candidate, index): SearchExecutionBudgetTier => {
    const tier = objectRecord(candidate)
    const field = `executionBudgets.search.tiers[${String(index)}]`
    if (tier === undefined || typeof tier.id !== 'string' || tier.id.length === 0
      || typeof tier.label !== 'string' || tier.label.length === 0) {
      throw new Error(`gongchuang-policy-gate: ${field} is incomplete`)
    }
    if (ids.has(tier.id)) throw new Error(`gongchuang-policy-gate: duplicate search budget tier ${tier.id}`)
    ids.add(tier.id)
    return {
      id: tier.id,
      label: tier.label,
      triggerAny: stringArray(tier.triggerAny, `${field}.triggerAny`),
      maxSteps: nonNegativeInteger(tier.maxSteps, `${field}.maxSteps`),
      maxSearchCalls: nonNegativeInteger(tier.maxSearchCalls, `${field}.maxSearchCalls`),
      maxFetchCalls: nonNegativeInteger(tier.maxFetchCalls, `${field}.maxFetchCalls`),
    }
  })
  if (!ids.has(budget.defaultTier)) {
    throw new Error('gongchuang-policy-gate: executionBudgets.search.defaultTier is not declared')
  }
  return {
    triggerAny: stringArray(budget.triggerAny, 'executionBudgets.search.triggerAny'),
    defaultTier: budget.defaultTier,
    tiers,
  }
}

function parseManifest(bytes: Buffer): SignedPolicyManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch (error: unknown) {
    throw new Error('gongchuang-policy-gate: policy manifest is not valid JSON', { cause: error })
  }
  const root = objectRecord(parsed)
  const product = objectRecord(root?.product)
  const providers = objectRecord(root?.providers)
  const tools = objectRecord(root?.tools)
  const executionBudgets = objectRecord(root?.executionBudgets)
  const delivery = objectRecord(root?.delivery)
  if (root?.schemaVersion !== 1 || product === undefined || providers === undefined
    || tools === undefined || executionBudgets === undefined || delivery === undefined) {
    throw new Error('gongchuang-policy-gate: unsupported or incomplete policy manifest')
  }
  if (typeof product.id !== 'string' || typeof product.clientVersion !== 'string'
    || typeof product.skillBundleVersion !== 'string' || typeof tools.allowUnattributed !== 'boolean') {
    throw new Error('gongchuang-policy-gate: invalid product or tool identity fields')
  }
  const rules = deliveryRules(delivery.rules)
  const professionalReceipt = deliveryReceipt(delivery.professionalReceipt, 'delivery.professionalReceipt')
  if (rules.some(rule => rule.receipts.some(receipt => receipt.id === professionalReceipt.id))) {
    throw new Error(`gongchuang-policy-gate: duplicate delivery receipt ${professionalReceipt.id}`)
  }
  return {
    schemaVersion: 1,
    product: {
      id: product.id,
      clientVersion: product.clientVersion,
      skillBundleVersion: product.skillBundleVersion,
    },
    providers: { allow: stringArray(providers.allow, 'providers.allow') },
    tools: {
      allow: stringArray(tools.allow, 'tools.allow'),
      ask: stringArray(tools.ask, 'tools.ask'),
      deny: stringArray(tools.deny, 'tools.deny'),
      allowUnattributed: tools.allowUnattributed,
    },
    executionBudgets: {
      search: searchExecutionBudget(executionBudgets.search),
    },
    delivery: { professionalReceipt, rules },
  }
}

function assertIdentity(policy: SignedPolicyManifest, config: Config): void {
  const expected = [
    ['product id', policy.product.id, config.expectedProductId],
    ['client version', policy.product.clientVersion, config.expectedClientVersion],
    ['skill bundle version', policy.product.skillBundleVersion, config.expectedSkillBundleVersion],
  ] as const
  for (const [label, actual, wanted] of expected) {
    if (actual !== wanted) {
      throw new Error(`gongchuang-policy-gate: ${label} mismatch (signed ${actual}, expected ${wanted})`)
    }
  }
}

function sameStringSet(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && expected.every(value => actual.includes(value))
}

function assertProductPolicyInvariants(policy: SignedPolicyManifest): void {
  const approvedRoutes = GONGCHUANG_MODEL_PROVIDERS.map(provider => provider.route)
  if (!sameStringSet(policy.providers.allow, approvedRoutes)) {
    throw new Error('gongchuang-policy-gate: signed provider routes drifted from the approved model registry')
  }
  if (policy.tools.allowUnattributed) {
    throw new Error('gongchuang-policy-gate: unattributed tool execution cannot be enabled')
  }
  const search = policy.executionBudgets.search
  const tierById = new Map(search.tiers.map(tier => [tier.id, tier]))
  const standard = tierById.get('standard')
  const professionalTier = tierById.get('professional')
  const highAssurance = tierById.get('high-assurance')
  const tierOutOfRange = search.tiers.some(tier => tier.maxSteps < 4 || tier.maxSteps > 32
    || tier.maxSearchCalls < 1 || tier.maxSearchCalls > 8
    || tier.maxFetchCalls < 1 || tier.maxFetchCalls > 12)
  if (!search.triggerAny.includes('请对以下问题执行联网检索。') || search.defaultTier !== 'standard'
    || standard === undefined || professionalTier === undefined || highAssurance === undefined
    || standard.maxSteps < 8 || standard.maxSearchCalls < 2 || standard.maxFetchCalls < 4
    || professionalTier.maxSteps < 20 || professionalTier.maxSearchCalls < 6 || professionalTier.maxFetchCalls < 8
    || highAssurance.maxSteps < 24 || highAssurance.maxSearchCalls < 8 || highAssurance.maxFetchCalls < 12
    || !professionalTier.triggerAny.includes('政策') || !professionalTier.triggerAny.includes('项目匹配')
    || ['评分', '体检', '报告', '数字身份证', '找同行'].some(marker => !highAssurance.triggerAny.includes(marker))
    || tierOutOfRange) {
    throw new Error('gongchuang-policy-gate: signed search execution budget is outside the V0.1 product contract')
  }
  const allowed = policy.tools.allow.map(wildcard)
  const asked = policy.tools.ask.map(wildcard)
  const denied = policy.tools.deny.map(wildcard)
  if (!matches(asked, 'gongchuang_create_automation')
    || matches(allowed, 'gongchuang_create_automation')
    || matches(denied, 'gongchuang_create_automation')) {
    throw new Error('gongchuang-policy-gate: conversational automation creation must require user confirmation')
  }
  for (const tool of ['bash', 'pwsh']) {
    if (!matches(allowed, tool) || matches(denied, tool) || matches(asked, tool)) {
      throw new Error(`gongchuang-policy-gate: required skill execution tool ${tool} is not admitted`)
    }
  }
  for (const tool of ['exec_command', 'shell_command', 'terminal_send', 'subagent', 'workflow_run']) {
    if (!matches(denied, tool) || matches(allowed, tool) || matches(asked, tool)) {
      throw new Error(`gongchuang-policy-gate: raw execution tool ${tool} is not fail-closed`)
    }
  }
  for (const tool of [
    'skill',
    'run_code',
    'gongchuang_skill_operation',
    'gongchuang_render_pdf',
    'gongchuang_professional_validate',
    'gongchuang_content_audit',
    'gongchuang_visual_inspection',
    'gongchuang_branding_gate',
    'gongchuang_artifact_probe',
    'gongchuang_publish_files',
    'gm_status',
    'gm_stats',
    'gm_search',
    'gm_record',
  ]) {
    if (!matches(allowed, tool) || matches(denied, tool)) {
      throw new Error(`gongchuang-policy-gate: required trusted tool ${tool} is not admitted`)
    }
  }
  const professional = policy.delivery.professionalReceipt
  if (professional.id !== 'professional-kernel'
    || !sameStringSet(professional.producerTools, ['gongchuang_professional_validate'])) {
    throw new Error('gongchuang-policy-gate: professional receipt identity drifted')
  }
  const formal = policy.delivery.rules.filter(rule => rule.id === 'formal-artifact')
  const expectedReceipts = [
    'content-audit', 'visual-inspection', 'brand-watermark', 'artifact-openability',
  ]
  if (formal.length !== 1 || !sameStringSet(formal[0]?.receipts.map(receipt => receipt.id) ?? [], expectedReceipts)) {
    throw new Error('gongchuang-policy-gate: formal artifact receipt set is incomplete')
  }
}

/**
 * Read and verify one exact-byte Ed25519 policy envelope.
 * Missing files, invalid base64, invalid keys, a bad signature, or identity
 * drift all throw synchronously so the host cannot publish an unguarded agent.
 * @param config - Exact trust-anchor paths and signed product identities.
 * @returns Frozen verified manifest and SHA-256 digest of its signed bytes.
 */
export function loadVerifiedPolicy(config: Config): VerifiedPolicy {
  let manifestBytes: Buffer
  let signature: Buffer
  let publicKeyPem: Buffer
  try {
    manifestBytes = readFileSync(config.manifestPath)
    const encoded = readFileSync(config.signaturePath, 'utf8').trim()
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
      throw new Error('signature is not canonical base64')
    }
    signature = Buffer.from(encoded, 'base64')
    publicKeyPem = readFileSync(config.publicKeyPath)
  } catch (error: unknown) {
    throw new Error('gongchuang-policy-gate: cannot load signed policy envelope', { cause: error })
  }
  if (!/^[0-9a-f]{64}$/u.test(config.expectedPublicKeySha256)
    || createHash('sha256').update(publicKeyPem).digest('hex') !== config.expectedPublicKeySha256) {
    throw new Error('gongchuang-policy-gate: policy public key is not pinned by the host')
  }
  let valid = false
  try {
    valid = verify(null, manifestBytes, createPublicKey(publicKeyPem), signature)
  } catch (error: unknown) {
    throw new Error('gongchuang-policy-gate: policy signature verification failed', { cause: error })
  }
  if (!valid) throw new Error('gongchuang-policy-gate: policy signature is invalid')
  const manifest = parseManifest(manifestBytes)
  assertIdentity(manifest, config)
  assertProductPolicyInvariants(manifest)
  Object.freeze(manifest.providers.allow)
  Object.freeze(manifest.providers)
  Object.freeze(manifest.tools.allow)
  Object.freeze(manifest.tools.ask)
  Object.freeze(manifest.tools.deny)
  Object.freeze(manifest.tools)
  Object.freeze(manifest.executionBudgets.search.triggerAny)
  for (const tier of manifest.executionBudgets.search.tiers) {
    Object.freeze(tier.triggerAny)
    Object.freeze(tier)
  }
  Object.freeze(manifest.executionBudgets.search.tiers)
  Object.freeze(manifest.executionBudgets.search)
  Object.freeze(manifest.executionBudgets)
  for (const rule of manifest.delivery.rules) {
    Object.freeze(rule.triggerAny)
    for (const receipt of rule.receipts) {
      Object.freeze(receipt.producerTools)
      Object.freeze(receipt)
    }
    Object.freeze(rule.receipts)
    Object.freeze(rule)
  }
  Object.freeze(manifest.delivery.professionalReceipt.producerTools)
  Object.freeze(manifest.delivery.professionalReceipt)
  Object.freeze(manifest.delivery.rules)
  Object.freeze(manifest.delivery)
  Object.freeze(manifest.product)
  return {
    manifest: Object.freeze(manifest),
    sha256: createHash('sha256').update(manifestBytes).digest('hex'),
  }
}

interface ActiveDeliveryState {
  turn: number
  taskStartSeq: number
  contractVersion: string
  phase: ProfessionalCheckpointPhase
  required: Map<string, DeliveryReceiptDefinition>
  satisfied: Set<string>
  receiptSubjects: Map<string, string>
  professionalSkills: Set<string>
  contractSkills: Set<string>
  activatedSkills: Set<string>
  notifiedProfessionalSkills: Set<string>
  activationSequence: string[]
  requiresSpecificRoute: boolean
  responseDepth: ProfessionalResponseDepth
  markerGroups: Map<string, readonly (readonly string[])[]>
  userEvidenceText: string
  evidenceReceipts: Map<string, EvidenceReceipt>
  professionalLedger?: ProfessionalLedger
  formalArtifactPaths: Set<string>
  artifactBinding?: ArtifactBinding
  noticeInjected: boolean
  genericArtifactRequested: boolean
  genericArtifactNoticeInjected: boolean
  searchBudgetActive: boolean
  searchBudgetTierId: string
  searchCalls: number
  fetchCalls: number
  searchCallIds: Set<string>
  fetchCallIds: Set<string>
  searchFinalNoticeInjected: boolean
  correctionCount: number
  professionalValidationFailures: number
  professionalRepairPending: boolean
  professionalRepairStepIssued: boolean
  professionalRepairWriteRetryUsed: boolean
  professionalRepairWriteRetryPath?: string
  professionalRepairIssues: readonly string[]
  professionalRepairCandidateText?: string
  professionalRepairArtifactPath?: string
  authoredArtifactPaths: Set<string>
  enterpriseSourceFailures: Map<string, number>
  terminalOutcome?: ProfessionalTerminalOutcome
  lastDeliveryNotice?: string
  expandedCandidateSha256?: string
  awaitingEnterprisePanoramaMode: boolean
}

interface ProfessionalTerminalOutcome {
  status: 'draft' | 'waiting-user' | 'failed'
  issues: readonly string[]
  candidateText?: string
  artifactPath?: string
  originalArtifactPath?: string
}

interface EvidenceReceipt {
  toolCallId: string
  toolName: string
  operationId?: string
  sha256: string
  text: string
  sourceUrls: readonly string[]
  sourcePaths: readonly string[]
  accessedAt: string
}

interface ProfessionalLedger {
  evidence: readonly ProfessionalEvidence[]
  calculations: readonly ProfessionalCalculation[]
}

interface SerializedDeliveryState {
  requiredIds: string[]
  satisfied: string[]
  receiptSubjects: [string, string][]
  professionalSkills: string[]
  contractSkills: string[]
  activatedSkills: string[]
  notifiedProfessionalSkills: string[]
  activationSequence: string[]
  requiresSpecificRoute: boolean
  responseDepth: ProfessionalResponseDepth
  userEvidenceText: string
  evidenceReceipts: EvidenceReceipt[]
  professionalLedger?: ProfessionalLedger
  formalArtifactPaths: string[]
  artifactBinding?: ArtifactBinding
  noticeInjected: boolean
  genericArtifactRequested: boolean
  genericArtifactNoticeInjected: boolean
  searchBudgetActive: boolean
  searchBudgetTierId: string
  searchCalls: number
  fetchCalls: number
  searchCallIds: string[]
  fetchCallIds: string[]
  searchFinalNoticeInjected: boolean
  correctionCount: number
  professionalValidationFailures: number
  professionalRepairPending: boolean
  professionalRepairStepIssued: boolean
  professionalRepairWriteRetryUsed?: boolean
  professionalRepairWriteRetryPath?: string
  professionalRepairIssues: string[]
  professionalRepairCandidateText?: string
  professionalRepairArtifactPath?: string
  authoredArtifactPaths?: string[]
  enterpriseSourceFailures: [string, number][]
  terminalOutcome?: ProfessionalTerminalOutcome
  expandedCandidateSha256?: string
  awaitingEnterprisePanoramaMode: boolean
}

function createDeliveryState(
  turn: number,
  taskStartSeq: number,
  contractVersion: string,
  defaultSearchBudgetTier: string,
): ActiveDeliveryState {
  return {
    turn,
    taskStartSeq,
    contractVersion,
    phase: 'running',
    required: new Map<string, DeliveryReceiptDefinition>(),
    satisfied: new Set<string>(),
    receiptSubjects: new Map<string, string>(),
    professionalSkills: new Set<string>(),
    contractSkills: new Set<string>(),
    activatedSkills: new Set<string>(),
    notifiedProfessionalSkills: new Set<string>(),
    activationSequence: [],
    requiresSpecificRoute: false,
    responseDepth: 'query',
    markerGroups: new Map<string, readonly (readonly string[])[]>(),
    userEvidenceText: '',
    evidenceReceipts: new Map<string, EvidenceReceipt>(),
    formalArtifactPaths: new Set<string>(),
    noticeInjected: false,
    genericArtifactRequested: false,
    genericArtifactNoticeInjected: false,
    searchBudgetActive: false,
    searchBudgetTierId: defaultSearchBudgetTier,
    searchCalls: 0,
    fetchCalls: 0,
    searchCallIds: new Set<string>(),
    fetchCallIds: new Set<string>(),
    searchFinalNoticeInjected: false,
    correctionCount: 0,
    professionalValidationFailures: 0,
    professionalRepairPending: false,
    professionalRepairStepIssued: false,
    professionalRepairWriteRetryUsed: false,
    professionalRepairIssues: [],
    authoredArtifactPaths: new Set<string>(),
    enterpriseSourceFailures: new Map<string, number>(),
    awaitingEnterprisePanoramaMode: false,
  }
}

function serializeDeliveryState(state: ActiveDeliveryState): SerializedDeliveryState {
  return {
    requiredIds: [...state.required.keys()],
    satisfied: [...state.satisfied],
    receiptSubjects: [...state.receiptSubjects],
    professionalSkills: [...state.professionalSkills],
    contractSkills: [...state.contractSkills],
    activatedSkills: [...state.activatedSkills],
    notifiedProfessionalSkills: [...state.notifiedProfessionalSkills],
    activationSequence: [...state.activationSequence],
    requiresSpecificRoute: state.requiresSpecificRoute,
    responseDepth: state.responseDepth,
    userEvidenceText: state.userEvidenceText,
    evidenceReceipts: [...state.evidenceReceipts.values()],
    ...(state.professionalLedger === undefined ? {} : { professionalLedger: state.professionalLedger }),
    formalArtifactPaths: [...state.formalArtifactPaths],
    ...(state.artifactBinding === undefined ? {} : { artifactBinding: state.artifactBinding }),
    noticeInjected: state.noticeInjected,
    genericArtifactRequested: state.genericArtifactRequested,
    genericArtifactNoticeInjected: state.genericArtifactNoticeInjected,
    searchBudgetActive: state.searchBudgetActive,
    searchBudgetTierId: state.searchBudgetTierId,
    searchCalls: state.searchCalls,
    fetchCalls: state.fetchCalls,
    searchCallIds: [...state.searchCallIds],
    fetchCallIds: [...state.fetchCallIds],
    searchFinalNoticeInjected: state.searchFinalNoticeInjected,
    correctionCount: state.correctionCount,
    professionalValidationFailures: state.professionalValidationFailures,
    professionalRepairPending: state.professionalRepairPending,
    professionalRepairStepIssued: state.professionalRepairStepIssued,
    professionalRepairWriteRetryUsed: state.professionalRepairWriteRetryUsed,
    ...(state.professionalRepairWriteRetryPath === undefined
      ? {}
      : { professionalRepairWriteRetryPath: state.professionalRepairWriteRetryPath }),
    professionalRepairIssues: [...state.professionalRepairIssues],
    ...(state.professionalRepairCandidateText === undefined
      ? {}
      : { professionalRepairCandidateText: state.professionalRepairCandidateText }),
    ...(state.professionalRepairArtifactPath === undefined
      ? {}
      : { professionalRepairArtifactPath: state.professionalRepairArtifactPath }),
    authoredArtifactPaths: [...state.authoredArtifactPaths],
    enterpriseSourceFailures: [...state.enterpriseSourceFailures],
    ...(state.terminalOutcome === undefined ? {} : { terminalOutcome: state.terminalOutcome }),
    ...(state.expandedCandidateSha256 === undefined ? {} : { expandedCandidateSha256: state.expandedCandidateSha256 }),
    awaitingEnterprisePanoramaMode: state.awaitingEnterprisePanoramaMode,
  }
}

function checkpointStrings(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`检查点 ${field} 无效`)
  return value.map((row): string => {
    if (typeof row !== 'string') throw new Error(`检查点 ${field} 无效`)
    return row
  })
}

function checkpointNumbers(value: unknown, field: string): number[] {
  if (!Array.isArray(value)) throw new Error(`检查点 ${field} 无效`)
  return value.map((entry): number => {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) throw new Error(`检查点 ${field} 无效`)
    return entry
  })
}

function checkpointPairs(value: unknown, field: string): [string, string][] {
  if (!Array.isArray(value)) throw new Error(`检查点 ${field} 无效`)
  return value.map((row): [string, string] => {
    if (!Array.isArray(row) || row.length !== 2 || row.some(item => typeof item !== 'string')) {
      throw new Error(`检查点 ${field} 无效`)
    }
    return [row[0] as string, row[1] as string]
  })
}

function checkpointCounters(value: unknown, field: string): [string, number][] {
  if (!Array.isArray(value)) throw new Error(`检查点 ${field} 无效`)
  return value.map((row): [string, number] => {
    if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string'
      || typeof row[1] !== 'number' || !Number.isSafeInteger(row[1]) || row[1] < 0) {
      throw new Error(`检查点 ${field} 无效`)
    }
    return [row[0], row[1]]
  })
}

function checkpointBoolean(row: Record<string, unknown>, field: string): boolean {
  if (typeof row[field] !== 'boolean') throw new Error(`检查点 ${field} 无效`)
  return row[field]
}

function checkpointInteger(row: Record<string, unknown>, field: string): number {
  const value = row[field]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`检查点 ${field} 无效`)
  }
  return value
}

function checkpointArtifactBinding(value: unknown): ArtifactBinding | undefined {
  if (value === undefined) return undefined
  const row = objectRecord(value)
  if (row === undefined || typeof row.path !== 'string' || typeof row.format !== 'string'
    || typeof row.sha256 !== 'string' || typeof row.candidateSha256 !== 'string'
    || typeof row.contentSha256 !== 'string'
    || (row.deliveryProfileId !== undefined && typeof row.deliveryProfileId !== 'string')) {
    throw new Error('检查点 artifactBinding 无效')
  }
  return {
    path: row.path,
    format: row.format,
    sha256: row.sha256,
    candidateSha256: row.candidateSha256,
    contentSha256: row.contentSha256,
    ...(row.deliveryProfileId === undefined ? {} : { deliveryProfileId: row.deliveryProfileId }),
  }
}

function checkpointTerminalOutcome(value: unknown): ProfessionalTerminalOutcome | undefined {
  if (value === undefined) return undefined
  const row = objectRecord(value)
  if (row === undefined || (row.status !== 'draft' && row.status !== 'waiting-user' && row.status !== 'failed')
    || !Array.isArray(row.issues) || row.issues.some(issue => typeof issue !== 'string')
    || (row.candidateText !== undefined && typeof row.candidateText !== 'string')
    || (row.artifactPath !== undefined && typeof row.artifactPath !== 'string')
    || (row.originalArtifactPath !== undefined && typeof row.originalArtifactPath !== 'string')) {
    throw new Error('检查点 terminalOutcome 无效')
  }
  return {
    status: row.status,
    issues: checkpointStrings(row.issues, 'terminalOutcome.issues'),
    ...(row.candidateText === undefined ? {} : { candidateText: row.candidateText }),
    ...(row.artifactPath === undefined ? {} : { artifactPath: row.artifactPath }),
    ...(row.originalArtifactPath === undefined ? {} : { originalArtifactPath: row.originalArtifactPath }),
  }
}

function checkpointEvidenceReceipts(value: unknown): EvidenceReceipt[] {
  if (!Array.isArray(value)) throw new Error('检查点 evidenceReceipts 无效')
  return value.map((candidate): EvidenceReceipt => {
    const row = objectRecord(candidate)
    if (row === undefined || typeof row.toolCallId !== 'string' || typeof row.toolName !== 'string'
      || (row.operationId !== undefined && typeof row.operationId !== 'string')
      || typeof row.sha256 !== 'string' || typeof row.text !== 'string'
      || !Array.isArray(row.sourceUrls) || row.sourceUrls.some(url => typeof url !== 'string')
      || (row.sourcePaths !== undefined
        && (!Array.isArray(row.sourcePaths) || row.sourcePaths.some(path => typeof path !== 'string')))
      || typeof row.accessedAt !== 'string' || !Number.isFinite(Date.parse(row.accessedAt))) {
      throw new Error('检查点 evidenceReceipts 无效')
    }
    if (createHash('sha256').update(row.text).digest('hex') !== row.sha256) {
      throw new Error('检查点证据正文与摘要不一致')
    }
    return {
      toolCallId: row.toolCallId,
      toolName: row.toolName,
      ...(row.operationId === undefined ? {} : { operationId: row.operationId }),
      sha256: row.sha256,
      text: row.text,
      sourceUrls: checkpointStrings(row.sourceUrls, 'evidenceReceipts.sourceUrls'),
      // V1 检查点没有保存调用文件路径，恢复时默认为空集合不扩大信任。
      sourcePaths: row.sourcePaths === undefined
        ? []
        : checkpointStrings(row.sourcePaths, 'evidenceReceipts.sourcePaths'),
      accessedAt: row.accessedAt,
    }
  })
}

function professionalLedger(
  evidence: readonly ProfessionalEvidence[],
  calculations: readonly ProfessionalCalculation[] = [],
): ProfessionalLedger {
  return Object.freeze({
    evidence: Object.freeze(evidence.map(item => Object.freeze({
      ...item,
      ...(item.values === undefined ? {} : { values: [...item.values] }),
    }))),
    calculations: Object.freeze(calculations.map(item => Object.freeze({
      ...item,
      inputs: [...item.inputs],
      ...(item.weights === undefined ? {} : { weights: [...item.weights] }),
      evidenceIds: [...item.evidenceIds],
    }))),
  })
}

function checkpointProfessionalLedger(value: unknown): ProfessionalLedger | undefined {
  if (value === undefined) return undefined
  const row = objectRecord(value)
  if (row === undefined || !Array.isArray(row.evidence) || !Array.isArray(row.calculations)) {
    throw new Error('检查点 professionalLedger 无效')
  }
  const evidence = row.evidence.map((candidate): ProfessionalEvidence => {
    const item = objectRecord(candidate)
    if (item === undefined || typeof item.id !== 'string' || typeof item.kind !== 'string'
      || !['verified', 'user-provided', 'calculated', 'pending', 'conflict'].includes(String(item.status))
      || typeof item.source !== 'string'
      || (item.toolCallId !== undefined && typeof item.toolCallId !== 'string')
      || (item.sourceUrl !== undefined && typeof item.sourceUrl !== 'string')
      || (item.sha256 !== undefined && typeof item.sha256 !== 'string')
      || (item.asOf !== undefined && typeof item.asOf !== 'string')
      || (item.values !== undefined
        && (!Array.isArray(item.values) || item.values.some(entry => typeof entry !== 'string')))) {
      throw new Error('检查点 professionalLedger.evidence 无效')
    }
    return {
      id: item.id,
      kind: item.kind,
      status: item.status as ProfessionalEvidence['status'],
      source: item.source,
      ...(item.toolCallId === undefined ? {} : { toolCallId: item.toolCallId }),
      ...(item.sourceUrl === undefined ? {} : { sourceUrl: item.sourceUrl }),
      ...(item.sha256 === undefined ? {} : { sha256: item.sha256 }),
      ...(item.asOf === undefined ? {} : { asOf: item.asOf }),
      ...(item.values === undefined ? {} : { values: checkpointStrings(item.values, 'professionalLedger.evidence.values') }),
    }
  })
  const calculations = row.calculations.map((candidate): ProfessionalCalculation => {
    const item = objectRecord(candidate)
    if (item === undefined || typeof item.id !== 'string'
      || !['sum', 'subtract', 'multiply', 'divide', 'ratio', 'weighted-sum'].includes(String(item.operator))
      || !Array.isArray(item.inputs) || item.inputs.some(entry => typeof entry !== 'number' || !Number.isFinite(entry))
      || typeof item.result !== 'number' || !Number.isFinite(item.result)
      || (item.weights !== undefined
        && (!Array.isArray(item.weights) || item.weights.some(entry => typeof entry !== 'number' || !Number.isFinite(entry))))
      || !Array.isArray(item.evidenceIds) || item.evidenceIds.some(entry => typeof entry !== 'string')) {
      throw new Error('检查点 professionalLedger.calculations 无效')
    }
    const inputs = checkpointNumbers(item.inputs, 'professionalLedger.calculations.inputs')
    const weights = item.weights === undefined
      ? undefined
      : checkpointNumbers(item.weights, 'professionalLedger.calculations.weights')
    return {
      id: item.id,
      operator: item.operator as ProfessionalCalculation['operator'],
      inputs,
      ...(weights === undefined ? {} : { weights }),
      result: item.result,
      evidenceIds: checkpointStrings(item.evidenceIds, 'professionalLedger.calculations.evidenceIds'),
    }
  })
  return professionalLedger(evidence, calculations)
}

function restoreDeliveryState(
  value: unknown,
  turn: number,
  taskStartSeq: number,
  contractVersion: string,
  phase: ProfessionalCheckpointPhase,
  policy: SignedPolicyManifest,
  contracts: ProfessionalContracts,
): ActiveDeliveryState {
  const row = objectRecord(value)
  if (row === undefined || typeof row.userEvidenceText !== 'string'
    || typeof row.searchBudgetTierId !== 'string'
    || (row.responseDepth !== 'query' && row.responseDepth !== 'analysis' && row.responseDepth !== 'formal')
    || (row.expandedCandidateSha256 !== undefined && typeof row.expandedCandidateSha256 !== 'string')
    || (row.professionalRepairCandidateText !== undefined && typeof row.professionalRepairCandidateText !== 'string')
    || (row.professionalRepairArtifactPath !== undefined && typeof row.professionalRepairArtifactPath !== 'string')
    || (row.professionalRepairWriteRetryPath !== undefined && typeof row.professionalRepairWriteRetryPath !== 'string')) {
    throw new Error('检查点专业任务字段无效')
  }
  const receiptCatalog = new Map<string, DeliveryReceiptDefinition>([
    [policy.delivery.professionalReceipt.id, policy.delivery.professionalReceipt],
    ...policy.delivery.rules.flatMap(rule => rule.receipts.map(receipt => [receipt.id, receipt] as const)),
  ])
  const required = new Map<string, DeliveryReceiptDefinition>()
  for (const id of checkpointStrings(row.requiredIds, 'requiredIds')) {
    const receipt = receiptCatalog.get(id)
    if (receipt === undefined) throw new Error(`检查点引用当前合同中不存在的回执 ${id}`)
    required.set(id, receipt)
  }
  const contractSkills = new Set(checkpointStrings(row.contractSkills, 'contractSkills'))
  const markerGroups = new Map<string, readonly (readonly string[])[]>()
  for (const skill of contractSkills) {
    const rule = contracts.skills.get(skill)
    if (rule !== undefined) markerGroups.set(skill, markerGroupsForDepth(rule, row.responseDepth))
  }
  const evidenceReceipts = checkpointEvidenceReceipts(row.evidenceReceipts)
  const savedProfessionalLedger = checkpointProfessionalLedger(row.professionalLedger)
  const artifactBinding = checkpointArtifactBinding(row.artifactBinding)
  const terminalOutcome = checkpointTerminalOutcome(row.terminalOutcome)
  const state: ActiveDeliveryState = {
    turn,
    taskStartSeq,
    contractVersion,
    phase,
    required,
    satisfied: new Set(checkpointStrings(row.satisfied, 'satisfied')),
    receiptSubjects: new Map(checkpointPairs(row.receiptSubjects, 'receiptSubjects')),
    professionalSkills: new Set(checkpointStrings(row.professionalSkills, 'professionalSkills')),
    contractSkills,
    activatedSkills: new Set(checkpointStrings(row.activatedSkills, 'activatedSkills')),
    notifiedProfessionalSkills: new Set(checkpointStrings(row.notifiedProfessionalSkills, 'notifiedProfessionalSkills')),
    activationSequence: checkpointStrings(row.activationSequence, 'activationSequence'),
    requiresSpecificRoute: checkpointBoolean(row, 'requiresSpecificRoute'),
    responseDepth: row.responseDepth,
    markerGroups,
    userEvidenceText: row.userEvidenceText,
    evidenceReceipts: new Map(evidenceReceipts.map(receipt => [receipt.toolCallId, receipt])),
    ...(savedProfessionalLedger === undefined ? {} : { professionalLedger: savedProfessionalLedger }),
    formalArtifactPaths: new Set(checkpointStrings(row.formalArtifactPaths, 'formalArtifactPaths')),
    ...(artifactBinding === undefined ? {} : { artifactBinding }),
    noticeInjected: checkpointBoolean(row, 'noticeInjected'),
    genericArtifactRequested: checkpointBoolean(row, 'genericArtifactRequested'),
    genericArtifactNoticeInjected: checkpointBoolean(row, 'genericArtifactNoticeInjected'),
    searchBudgetActive: checkpointBoolean(row, 'searchBudgetActive'),
    searchBudgetTierId: row.searchBudgetTierId,
    searchCalls: checkpointInteger(row, 'searchCalls'),
    fetchCalls: checkpointInteger(row, 'fetchCalls'),
    searchCallIds: new Set(checkpointStrings(row.searchCallIds, 'searchCallIds')),
    fetchCallIds: new Set(checkpointStrings(row.fetchCallIds, 'fetchCallIds')),
    searchFinalNoticeInjected: checkpointBoolean(row, 'searchFinalNoticeInjected'),
    correctionCount: checkpointInteger(row, 'correctionCount'),
    professionalValidationFailures: checkpointInteger(row, 'professionalValidationFailures'),
    // V1 checkpoints created before the bounded repair step did not carry
    // these fields.  Defaulting only those absent fields keeps existing paused
    // tasks resumable without weakening validation of newly written values.
    professionalRepairPending: row.professionalRepairPending === undefined
      ? false
      : checkpointBoolean(row, 'professionalRepairPending'),
    professionalRepairStepIssued: row.professionalRepairStepIssued === undefined
      ? false
      : checkpointBoolean(row, 'professionalRepairStepIssued'),
    professionalRepairWriteRetryUsed: row.professionalRepairWriteRetryUsed === undefined
      ? false
      : checkpointBoolean(row, 'professionalRepairWriteRetryUsed'),
    ...(row.professionalRepairWriteRetryPath === undefined
      ? {}
      : { professionalRepairWriteRetryPath: row.professionalRepairWriteRetryPath }),
    professionalRepairIssues: row.professionalRepairIssues === undefined
      ? []
      : checkpointStrings(row.professionalRepairIssues, 'professionalRepairIssues'),
    ...(row.professionalRepairCandidateText === undefined
      ? {}
      : { professionalRepairCandidateText: row.professionalRepairCandidateText }),
    ...(row.professionalRepairArtifactPath === undefined
      ? {}
      : { professionalRepairArtifactPath: row.professionalRepairArtifactPath }),
    // Older checkpoints predate authored source tracking. An absent field is
    // safe because it grants no additional repair-time reads.
    authoredArtifactPaths: new Set(row.authoredArtifactPaths === undefined
      ? []
      : checkpointStrings(row.authoredArtifactPaths, 'authoredArtifactPaths')),
    enterpriseSourceFailures: new Map(checkpointCounters(row.enterpriseSourceFailures, 'enterpriseSourceFailures')),
    ...(terminalOutcome === undefined ? {} : { terminalOutcome }),
    ...(row.expandedCandidateSha256 === undefined ? {} : { expandedCandidateSha256: row.expandedCandidateSha256 }),
    awaitingEnterprisePanoramaMode: checkpointBoolean(row, 'awaitingEnterprisePanoramaMode'),
  }
  return state
}

type EnterpriseSourceProvider = 'tianyancha' | 'qcc'

function enterpriseSourceProvider(toolName: string): EnterpriseSourceProvider | undefined {
  if (toolName.startsWith('mcp__tianyancha__')) return 'tianyancha'
  if (toolName.startsWith('mcp__qcc_')) return 'qcc'
  return undefined
}

function enterpriseSourceCallKey(exec: ToolExecution): string | undefined {
  const provider = enterpriseSourceProvider(exec.name)
  if (provider === undefined) return undefined
  const argumentsSha256 = createHash('sha256').update(JSON.stringify(exec.arguments)).digest('hex')
  return `${provider}:${exec.name}:${argumentsSha256}`
}

function enterpriseSourceFailureIsTerminal(result: ToolExecutionResult): boolean {
  const text = resultEvidenceText(result)
  return /(?:取消|拒绝授权|401|403|429|额度|配额|quota|rate.?limit|unauthori[sz]ed|forbidden|unknown tool|未知.*工具|不支持)/iu.test(text)
}

interface PendingReceiptClaim {
  agent: Agent
  receipts: Map<string, string | undefined>
  artifactBinding?: ArtifactBinding
  professionalLedger?: ProfessionalLedger
}

interface ArtifactBinding {
  path: string
  format: string
  sha256: string
  candidateSha256: string
  contentSha256: string
  deliveryProfileId?: string
}

const MAX_EVIDENCE_RECEIPT_TEXT = 1_000_000
const FORMAL_ARTIFACT_SUFFIX = /\.(?:docx|xlsx|xlsm|pptx|pdf|html?)$/iu
const FORMAL_ARTIFACT_EXTENSION_MARKERS = new Set([
  '.docx', '.xlsx', '.xlsm', '.pptx', '.pdf', '.html', '.htm',
])
const FORMAL_PATH_KEYS = new Set([
  'artifactPath', 'destination', 'file', 'filePath', 'output', 'outputFile', 'outputPath', 'path', 'target',
])

function searchBudgetToolKind(name: string): 'search' | 'fetch' | undefined {
  if (name === 'web_search' || name === 'mcp__gongchuang_search__evidence_search') return 'search'
  if (name === 'web_fetch') return 'fetch'
  return undefined
}

const GONGCHUANG_SEARCH_CHILD_SUFFIX = ':gongchuang-search'

function searchBudgetLogicalCallId(name: string, callId: string): string {
  if (name === 'web_search' && callId.endsWith(GONGCHUANG_SEARCH_CHILD_SUFFIX)) {
    return callId.slice(0, -GONGCHUANG_SEARCH_CHILD_SUFFIX.length)
  }
  return callId
}

function selectedSearchBudget(
  budget: SearchExecutionBudget,
  tierId: string,
): SearchExecutionBudgetTier {
  return budget.tiers.find(tier => tier.id === tierId)
    ?? budget.tiers.find(tier => tier.id === budget.defaultTier)
    ?? (() => { throw new Error('gongchuang-policy-gate: signed search budget has no default tier') })()
}

function searchBudgetForText(budget: SearchExecutionBudget, text: string): SearchExecutionBudgetTier {
  const matched = budget.tiers.filter(tier => tier.triggerAny.some(trigger => text.includes(trigger)))
  return matched.at(-1) ?? selectedSearchBudget(budget, budget.defaultTier)
}

function resultEvidenceText(result: ToolExecutionResult): string {
  const contentText = result.content
    .map(block => block.type === 'text' ? block.text : '')
    .filter(Boolean)
    .join('\n')
  const valueText = result.value === undefined ? '' : JSON.stringify(result.value)
  // MCP implementations often put the auditable payload in structured value
  // while their visible content is only a short status message. Preserve both
  // so exact evidence binding never depends on adapter presentation choices.
  const evidenceText = [contentText, valueText].filter(Boolean).join('\n')
  return normalizeProfessionalCandidate(evidenceText.slice(0, MAX_EVIDENCE_RECEIPT_TEXT))
}

function invocationSourceUrls(value: unknown, result = new Set<string>()): readonly string[] {
  if (typeof value === 'string') {
    for (const hit of value.match(/https?:\/\/[^\s"'<>]+/giu) ?? []) {
      const normalized = hit.replace(/[),.;\]}>，。；）】》]+$/gu, '')
      try {
        const url = new URL(normalized)
        if (url.protocol === 'http:' || url.protocol === 'https:') result.add(normalized)
      } catch { /* non-URL strings never become evidence provenance */ }
    }
    return Object.freeze([...result])
  }
  if (Array.isArray(value)) {
    for (const entry of value) invocationSourceUrls(entry, result)
    return Object.freeze([...result])
  }
  const record = objectRecord(value)
  if (record !== undefined) {
    for (const entry of Object.values(record)) invocationSourceUrls(entry, result)
  }
  return Object.freeze([...result])
}

const EVIDENCE_SOURCE_EXTENSIONS = new Set([
  '.csv', '.doc', '.docx', '.gif', '.htm', '.html', '.jpeg', '.jpg', '.json', '.md', '.ods', '.odt',
  '.pdf', '.png', '.ppt', '.pptx', '.rtf', '.svg', '.tif', '.tiff', '.tsv', '.txt', '.webp', '.wps',
  '.xls', '.xlsx',
])

function invocationSourcePaths(value: unknown, result = new Set<string>()): readonly string[] {
  if (typeof value === 'string') {
    if (EVIDENCE_SOURCE_EXTENSIONS.has(extname(value.trim()).toLowerCase())) {
      result.add(value.trim())
    }
    return Object.freeze([...result])
  }
  if (Array.isArray(value)) {
    for (const entry of value) invocationSourcePaths(entry, result)
    return Object.freeze([...result])
  }
  const record = objectRecord(value)
  if (record !== undefined) {
    for (const entry of Object.values(record)) invocationSourcePaths(entry, result)
  }
  return Object.freeze([...result])
}

function receiptMatchesSourceLabel(receipt: EvidenceReceipt, sourceLabel: string): boolean {
  if (sourceLabel === '') return false
  return receipt.sourcePaths.some((path) => {
    const normalizedPath = normalizeProfessionalCandidate(path)
    return normalizedPath === sourceLabel
      || basename(normalizedPath) === basename(sourceLabel)
      || normalizedPath.endsWith(`/${sourceLabel}`)
      || normalizedPath.endsWith(`\\${sourceLabel}`)
  })
}

function distinctLogicalLocalReads(receipts: readonly EvidenceReceipt[]): EvidenceReceipt[] {
  const logicalSources = new Map<string, EvidenceReceipt>()
  for (const receipt of receipts) {
    // 同一路径、同一内容的重复读取只是同一个逻辑来源。历史实现按 toolCallId
    // 计数，模型偶尔重复 read 一次就会制造“多个来源”假冲突并触发修复循环。
    // 路径或正文摘要不同仍保持独立，真实的跨文件歧义不会被合并。
    const key = JSON.stringify([
      receipt.toolName,
      receipt.sha256,
      [...receipt.sourcePaths].sort(),
      [...receipt.sourceUrls].sort(),
    ])
    logicalSources.set(key, receipt)
  }
  return [...logicalSources.values()]
}

function evidenceTextIncludesValue(source: string, value: string): boolean {
  const normalized = normalizeProfessionalCandidate(value)
  if (normalized === '' || source.includes(normalized)) return normalized !== ''
  // 客户文件抽取器与模型有时只会在摘录末尾选择不同的句末标点。先只放宽
  // 末尾标点，不改正文内部字符、数字或括号，避免把意译后的事实冒充证据。
  const withoutTrailingPunctuation = normalized.replace(/[,.!?;:\u3001\uff0c\u3002\uff01\uff1a\uff1b\uff1f]+$/gu, '').trimEnd()
  if (withoutTrailingPunctuation !== '' && source.includes(withoutTrailingPunctuation)) return true
  // 读取结果与模型摘录也可能只在句读选择上不同，例如原文用分号而摘录用
  // 逗号。把非数字之间的句读统一为同一个占位符，正文字符和数字仍须逐字
  // 相同；数字之间的点号和逗号保持原样，避免把 1.0 与 10 等数值混同。
  const canonicalPunctuation = (text: string): string => Array.from(text).map((character, index, characters) => {
    if (!/[,.!?;:\u3001\uff0c\u3002\uff01\uff1a\uff1b\uff1f]/u.test(character)) return character
    const previous = characters[index - 1] ?? ''
    const next = characters[index + 1] ?? ''
    return /\d/u.test(previous) && /\d/u.test(next) ? character : '\u241f'
  }).join('')
  const canonicalSource = canonicalPunctuation(source)
  const canonicalValue = canonicalPunctuation(normalized)
  if (canonicalValue !== '' && canonicalSource.includes(canonicalValue)) return true
  const canonicalWithoutTrailing = canonicalPunctuation(withoutTrailingPunctuation)
  return canonicalWithoutTrailing !== '' && canonicalSource.includes(canonicalWithoutTrailing)
}

function evidenceNumberValues(text: string): string[] {
  return professionalEvidenceNumberTokens(text)
}

function signedSkillOperationId(value: unknown): string | undefined {
  const operation = objectRecord(value)?.operation
  return typeof operation === 'string' && operation.trim() !== '' ? operation.trim() : undefined
}

function signedCalculationReceipt(receipt: EvidenceReceipt): boolean {
  if (receipt.toolName !== 'gongchuang_skill_operation' || receipt.operationId === undefined) return false
  // 已签名 preflight 与计算脚本一样是确定性操作。历史上这里只识别
  // calculate，导致 preflight 返回的 policy_version 等数值无法复用回执，
  // 模型即使补了一条 calculated 证据仍会被反复判为“数字未绑定”。
  return /(?:^|[.-])calculat(?:e|ion)(?:[.-]|$)/iu.test(receipt.operationId)
    || /(?:^|[.-])run-preflight(?:[.-]|$)/iu.test(receipt.operationId)
    || /calculation-operation/iu.test(receipt.text)
}

function trustedEvidenceTool(name: string): boolean {
  return name === 'grep' || name === 'glob' || name === 'web_search' || name === 'web_fetch'
    || name === 'read' || name === 'read_image' || name.startsWith('mcp__')
    || name === 'gongchuang_skill_operation'
    || name.startsWith('get_') || name.startsWith('list_')
}

function customerFileEvidenceTool(name: string): boolean {
  return name === 'read' || name === 'read_image' || name === 'gongchuang_skill_operation'
    || name.startsWith('mcp__paddle_ocr__')
}

const USER_FILE_PATH = new RegExp([
  String.raw`(?:^|[\s"'“‘(（])(?:\.{0,2}[\\/]|[A-Za-z]:[\\/]|`,
  String.raw`[^\s"'“”‘’()（）<>|]+[\\/])[^\s"'“”‘’()（）<>|]+\.`,
  String.raw`(?:csv|doc|docx|gif|htm|html|jpeg|jpg|json|md|ods|odt|pdf|png|ppt|pptx|rtf|svg|`,
  String.raw`tif|tiff|tsv|txt|webp|wps|xls|xlsx)(?=$|[\s"'”’),，。;；:：])`,
].join(''), 'iu')
const USER_REQUESTS_FILE_SET = new RegExp([
  '批量(?:处理|读取|分析|检查)',
  '(?:处理|读取|分析|检查|扫描|遍历)(?:[^，。\\n]{0,12})?(?:全部|所有|整个)(?:[^，。\\n]{0,8})?(?:文件|目录|文件夹)',
  '(?:目录|文件夹)(?:内|下|中的)(?:[^，。\\n]{0,8})?(?:全部|所有|每个)文件',
].join('|'), 'iu')

function hasClosedExactFileInput(text: string): boolean {
  return USER_FILE_PATH.test(text) && !USER_REQUESTS_FILE_SET.test(text)
}

function formalArtifactPaths(
  value: unknown,
  key?: string,
  result = new Set<string>(),
  workspaceRoot = process.cwd(),
): Set<string> {
  if (typeof value === 'string') {
    if (key !== undefined && FORMAL_PATH_KEYS.has(key) && FORMAL_ARTIFACT_SUFFIX.test(value.trim())) {
      result.add(resolve(workspaceRoot, value.trim()))
    }
    return result
  }
  if (Array.isArray(value)) {
    for (const entry of value) formalArtifactPaths(entry, key, result, workspaceRoot)
    return result
  }
  const record = objectRecord(value)
  if (record === undefined) return result
  for (const [childKey, child] of Object.entries(record)) formalArtifactPaths(child, childKey, result, workspaceRoot)
  return result
}

function canonicalWorkspacePath(workspaceRoot: string, rawPath: string): string | undefined {
  if (rawPath.trim() === '') return undefined
  try {
    const canonicalRoot = realpathSync(workspaceRoot)
    const requestedPath = resolve(canonicalRoot, rawPath)
    if (!existsSync(requestedPath)) return undefined
    const canonicalPath = realpathSync(requestedPath)
    const workspacePrefix = canonicalRoot.endsWith(sep) ? canonicalRoot : `${canonicalRoot}${sep}`
    if (canonicalPath !== canonicalRoot && !canonicalPath.startsWith(workspacePrefix)) return undefined
    return canonicalPath
  } catch {
    return undefined
  }
}

function workspaceMutationPath(exec: ToolExecution): string | undefined {
  if (exec.name !== 'write' && exec.name !== 'edit') return undefined
  const args = objectRecord(exec.arguments)
  const rawPath = args?.file_path ?? args?.path
  if (typeof rawPath !== 'string' || rawPath.trim() === '') return undefined
  // A successful tool result without a resolvable workspace file must never
  // broaden the later repair exception.
  return canonicalWorkspacePath(professionalWorkspaceRoot(exec), rawPath)
}

/** One page image emitted by the signed desktop renderer. */
export interface ProfessionalRenderPage {
  page: number
  width: number
  height: number
  pngSha256: string
}

/** Native renderer receipt accepted by the visual delivery gate. */
export interface ProfessionalRenderReceipt {
  rendererId: 'gongchuang-electron-pymupdf-v2'
  status: 'passed-host-render'
  review: 'automatic-source-preview'
  artifactSha256: string
  comparison: {
    reference: 'same-source-print-layout'
    maxChangedPixelRatio: number
    maxMeanAbsoluteError: number
    changedPixelRatioTolerance: number
    meanAbsoluteErrorTolerance: number
  }
  pages: ProfessionalRenderPage[]
}

/** PDF text extracted by the signed desktop host from the exact file bytes. */
export interface ProfessionalPdfInspectionReceipt {
  rendererId: 'gongchuang-electron-pymupdf-v2'
  status: 'passed-host-pdf-inspection'
  artifactSha256: string
  pageCount: number
  contentText: string
  contentSha256: string
}

/** PDF created by the signed desktop host from one immutable validated source. */
export interface ProfessionalPdfExportReceipt {
  rendererId: 'gongchuang-electron-pymupdf-v2'
  status: 'passed-host-pdf-export'
  sourceArtifactSha256: string
  outputPath: string
  outputSha256: string
  bytes: number
}

/** Capability exposed only by the signed desktop host, never by a model plugin. */
export interface GongchuangArtifactRenderer {
  inspectPdf(request: Readonly<{
    artifactPath: string
    artifactSha256: string
    workspaceRoot: string
  }>): Promise<ProfessionalPdfInspectionReceipt>
  exportPdf(request: Readonly<{
    sourceArtifactPath: string
    sourceArtifactSha256: string
    sourceFormat: string
    outputPath: string
    workspaceRoot: string
  }>): Promise<ProfessionalPdfExportReceipt>
  renderAndReview(request: Readonly<{
    artifactPath: string
    artifactSha256: string
    format: string
    workspaceRoot: string
  }>): Promise<ProfessionalRenderReceipt>
}

function parsePdfExportReceipt(value: unknown): ProfessionalPdfExportReceipt {
  const receipt = objectRecord(value)
  if (receipt?.rendererId !== 'gongchuang-electron-pymupdf-v2'
    || receipt.status !== 'passed-host-pdf-export'
    || typeof receipt.sourceArtifactSha256 !== 'string'
    || typeof receipt.outputPath !== 'string'
    || typeof receipt.outputSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(receipt.outputSha256)
    || typeof receipt.bytes !== 'number' || !Number.isSafeInteger(receipt.bytes) || receipt.bytes <= 0) {
    throw new Error('可信 PDF 导出回执身份或结构无效')
  }
  return {
    rendererId: 'gongchuang-electron-pymupdf-v2',
    status: 'passed-host-pdf-export',
    sourceArtifactSha256: receipt.sourceArtifactSha256,
    outputPath: resolve(receipt.outputPath),
    outputSha256: receipt.outputSha256,
    bytes: receipt.bytes,
  }
}

function parseRenderReceipt(value: unknown): ProfessionalRenderReceipt {
  const receipt = objectRecord(value)
  const comparison = objectRecord(receipt?.comparison)
  if (receipt?.rendererId !== 'gongchuang-electron-pymupdf-v2'
    || receipt.status !== 'passed-host-render' || receipt.review !== 'automatic-source-preview'
    || typeof receipt.artifactSha256 !== 'string' || !Array.isArray(receipt.pages)
    || comparison?.reference !== 'same-source-print-layout'
    || typeof comparison.maxChangedPixelRatio !== 'number'
    || typeof comparison.maxMeanAbsoluteError !== 'number'
    || typeof comparison.changedPixelRatioTolerance !== 'number'
    || typeof comparison.meanAbsoluteErrorTolerance !== 'number'
    || comparison.maxChangedPixelRatio < 0 || comparison.maxChangedPixelRatio > comparison.changedPixelRatioTolerance
    || comparison.maxMeanAbsoluteError < 0 || comparison.maxMeanAbsoluteError > comparison.meanAbsoluteErrorTolerance) {
    throw new Error('可信逐页渲染回执身份或结构无效')
  }
  const pages = receipt.pages.map((candidate, index): ProfessionalRenderPage => {
    const page = objectRecord(candidate)
    if (page === undefined || typeof page.page !== 'number' || typeof page.width !== 'number'
      || typeof page.height !== 'number' || typeof page.pngSha256 !== 'string') {
      throw new Error(`可信逐页渲染回执第 ${String(index + 1)} 页结构无效`)
    }
    return { page: page.page, width: page.width, height: page.height, pngSha256: page.pngSha256 }
  })
  return {
    rendererId: 'gongchuang-electron-pymupdf-v2',
    status: 'passed-host-render',
    review: 'automatic-source-preview',
    artifactSha256: receipt.artifactSha256,
    comparison: {
      reference: 'same-source-print-layout',
      maxChangedPixelRatio: comparison.maxChangedPixelRatio,
      maxMeanAbsoluteError: comparison.maxMeanAbsoluteError,
      changedPixelRatioTolerance: comparison.changedPixelRatioTolerance,
      meanAbsoluteErrorTolerance: comparison.meanAbsoluteErrorTolerance,
    },
    pages,
  }
}

function parsePdfInspectionReceipt(value: unknown): ProfessionalPdfInspectionReceipt {
  const receipt = objectRecord(value)
  if (receipt?.rendererId !== 'gongchuang-electron-pymupdf-v2'
    || receipt.status !== 'passed-host-pdf-inspection'
    || typeof receipt.artifactSha256 !== 'string'
    || typeof receipt.pageCount !== 'number' || !Number.isSafeInteger(receipt.pageCount) || receipt.pageCount <= 0
    || typeof receipt.contentText !== 'string' || receipt.contentText.trim().length === 0
    || typeof receipt.contentSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(receipt.contentSha256)) {
    throw new Error('可信 PDF 正文回执身份或结构无效')
  }
  const normalized = normalizeProfessionalCandidate(receipt.contentText)
  if (createHash('sha256').update(normalized).digest('hex') !== receipt.contentSha256) {
    throw new Error('可信 PDF 正文回执摘要不一致')
  }
  return {
    rendererId: 'gongchuang-electron-pymupdf-v2',
    status: 'passed-host-pdf-inspection',
    artifactSha256: receipt.artifactSha256,
    pageCount: receipt.pageCount,
    contentText: normalized,
    contentSha256: receipt.contentSha256,
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    gongchuangPolicy: GongchuangPolicyService
    gongchuangArtifactRenderer?: GongchuangArtifactRenderer
  }
}

/**
 * Capability-limited receipt ledger. Trusted producer plugins receive this
 * service through declared Cordis injection and claim a receipt against the
 * exact live tool execution. The post-execute gate commits the claim only when
 * the tool succeeded and no later listener blocked its result.
 */
export class GongchuangPolicyService extends Service {
  private readonly pending = new Map<symbol, PendingReceiptClaim>()
  private readonly producers: ReadonlyMap<string, readonly RegExp[]>
  private readonly states: WeakMap<Agent, ActiveDeliveryState>
  private readonly professionalReceiptId: string
  private readonly activateFormalArtifact: (state: ActiveDeliveryState) => void

  constructor(
    ctx: Context,
    producers: ReadonlyMap<string, readonly RegExp[]>,
    states: WeakMap<Agent, ActiveDeliveryState>,
    professionalReceiptId: string,
    activateFormalArtifact: (state: ActiveDeliveryState) => void,
  ) {
    super(ctx, 'gongchuangPolicy')
    this.producers = producers
    this.states = states
    this.professionalReceiptId = professionalReceiptId
    this.activateFormalArtifact = activateFormalArtifact
  }

  /**
   * Claim one receipt from an approved producer tool; settlement is deferred.
   * @param exec - Live tool execution whose opaque token binds the claim.
   * @param receiptId - Active receipt authorized for the executing tool name.
   * @param subjectText - Exact normalized chat candidate to bind; omit for artifact receipts.
   * @param artifactBinding - Exact file and extracted-content identity; only the professional kernel may bind it.
   * @param ledger - Attested evidence checkpoint reused by the same task's artifact phase.
   */
  claim(
    exec: ToolExecution,
    receiptId: string,
    subjectText?: string,
    artifactBinding?: ArtifactBinding,
    ledger?: ProfessionalLedger,
  ): void {
    const agent = exec.agent
    const state = agent === undefined ? undefined : this.states.get(agent)
    const producerPatterns = this.producers.get(receiptId)
    if (agent === undefined || state === undefined || !state.required.has(receiptId)) {
      throw new Error(`gongchuang-policy-gate: receipt ${receiptId} is not active for this execution`)
    }
    if (producerPatterns === undefined || !matches(producerPatterns, exec.name)) {
      throw new Error(`gongchuang-policy-gate: tool ${exec.name} cannot produce receipt ${receiptId}`)
    }
    if (artifactBinding !== undefined && receiptId !== this.professionalReceiptId) {
      throw new Error('gongchuang-policy-gate: only the professional kernel may bind an artifact')
    }
    if (ledger !== undefined && receiptId !== this.professionalReceiptId) {
      throw new Error('gongchuang-policy-gate: only the professional kernel may checkpoint evidence')
    }
    if (artifactBinding !== undefined) this.activateFormalArtifact(state)
    const existing = this.pending.get(exec.token)
    if (existing !== undefined && existing.agent !== agent) {
      throw new Error('gongchuang-policy-gate: receipt claim agent mismatch')
    }
    const receipts = existing?.receipts ?? new Map<string, string | undefined>()
    receipts.set(receiptId, subjectText === undefined ? undefined : normalizeProfessionalCandidate(subjectText))
    const nextArtifactBinding = artifactBinding ?? existing?.artifactBinding
    const nextProfessionalLedger = ledger ?? existing?.professionalLedger
    this.pending.set(exec.token, {
      agent,
      receipts,
      ...(nextArtifactBinding === undefined ? {} : { artifactBinding: nextArtifactBinding }),
      ...(nextProfessionalLedger === undefined ? {} : { professionalLedger: nextProfessionalLedger }),
    })
  }

  /**
   * Persist attested evidence for the artifact phase without granting the
   * professional receipt. The pending write is committed only after the
   * current tool result is accepted, exactly like a normal receipt claim.
   * @param exec - Live validation execution that owns the pending checkpoint.
   * @param ledger - Host-attested evidence and calculations to reuse for the artifact.
   */
  checkpointProfessionalLedger(exec: ToolExecution, ledger: ProfessionalLedger): void {
    const agent = exec.agent
    const state = agent === undefined ? undefined : this.states.get(agent)
    if (agent === undefined || state === undefined || !state.required.has(this.professionalReceiptId)) {
      throw new Error('gongchuang-policy-gate: professional evidence checkpoint is not active for this execution')
    }
    const existing = this.pending.get(exec.token)
    if (existing !== undefined && existing.agent !== agent) {
      throw new Error('gongchuang-policy-gate: professional evidence checkpoint agent mismatch')
    }
    this.pending.set(exec.token, {
      agent,
      receipts: existing?.receipts ?? new Map<string, string | undefined>(),
      ...(existing?.artifactBinding === undefined ? {} : { artifactBinding: existing.artifactBinding }),
      professionalLedger: ledger,
    })
  }

  /**
   * Return the professional skills required by the live execution's current turn.
   * @param exec - Live execution whose agent owns the active turn state.
   * @returns A sorted immutable snapshot of required skill names.
   */
  requiredProfessionalSkills(exec: ToolExecution): readonly string[] {
    const state = exec.agent === undefined ? undefined : this.states.get(exec.agent)
    if (state === undefined) throw new Error('gongchuang-policy-gate: no active professional turn')
    return Object.freeze([...state.professionalSkills].sort())
  }

  /**
   * Return only task-owning skills whose response structure applies.
   * @param exec - Live execution whose agent owns the active turn state.
   * @returns A sorted immutable snapshot of task-owning skill names.
   */
  professionalContractSkills(exec: ToolExecution): readonly string[] {
    const state = exec.agent === undefined ? undefined : this.states.get(exec.agent)
    if (state === undefined) throw new Error('gongchuang-policy-gate: no active professional turn')
    return Object.freeze([...state.contractSkills].sort())
  }

  /**
   * Return the Host-derived response depth for the live professional turn.
   * @param exec - Tool execution attributed to the active agent.
   * @returns The response depth fixed for the current professional turn.
   */
  professionalResponseDepth(exec: ToolExecution): 'query' | 'analysis' | 'formal' {
    const state = exec.agent === undefined ? undefined : this.states.get(exec.agent)
    if (state === undefined) throw new Error('gongchuang-policy-gate: no active professional turn')
    return state.responseDepth
  }

  /**
   * Require a successful skill activation in the current attributed turn.
   * The signed script runner calls this inside its executor, so an alternate
   * caller cannot substitute a skill name without loading its instructions.
   * @param exec - Live tool execution whose agent owns the active turn.
   * @param skill - Exact owning skill declared by the signed operation registry.
   */
  assertSkillActivated(exec: ToolExecution, skill: string): void {
    const state = exec.agent === undefined ? undefined : this.states.get(exec.agent)
    if (state === undefined) throw new Error('gongchuang-policy-gate: no active turn for signed skill execution')
    if (!state.activatedSkills.has(skill)) {
      throw new Error(`gongchuang-policy-gate: skill ${skill} is not activated in the current turn. 先加载 skill({name:${JSON.stringify(skill)}})；若当前只开放 run_code，在其中 await tools.skill(...)，成功后再执行操作，不要直接调用未开放的根工具。`)
    }
  }

  /**
   * Bind model-declared evidence rows to user text or successful trusted tool output.
   * A model-supplied label, URL, or digest is never sufficient on its own.
   * @param exec - Live professional-validation execution.
   * @param evidence - Candidate evidence rows supplied by the model.
   * @param sourceText - Optional original text used by a rewriting task.
   * @returns Immutable evidence rows with Host-derived digests.
   */
  attestEvidence(
    exec: ToolExecution,
    evidence: readonly ProfessionalEvidence[],
    sourceText?: string,
  ): readonly ProfessionalEvidence[] {
    const state = exec.agent === undefined ? undefined : this.states.get(exec.agent)
    if (state === undefined) throw new Error('gongchuang-policy-gate: no active professional turn')
    const attested = evidence.map((item): ProfessionalEvidence => {
      const callId = item.toolCallId?.trim()
      let receipt = callId === undefined || callId === '' ? undefined : state.evidenceReceipts.get(callId)
      let canonicalCalculationOperation: string | undefined
      if (item.status === 'verified' && receipt === undefined && (callId === undefined || callId === '')) {
        const sourceUrl = normalizeProfessionalCandidate(item.sourceUrl ?? '')
        const values = (item.values ?? []).map(normalizeProfessionalCandidate).filter(Boolean)
        const sourceLabel = normalizeProfessionalCandidate(item.source)
        receipt = [...state.evidenceReceipts.values()].reverse().find((candidate) => {
          if (sourceUrl !== '' && !candidate.sourceUrls.includes(sourceUrl) && !candidate.text.includes(sourceUrl)) return false
          if (values.some(value => !evidenceTextIncludesValue(candidate.text, value))) return false
          if (sourceUrl === '' && values.length === 0) {
            return sourceLabel !== '' && candidate.text.includes(sourceLabel)
          }
          return true
        })
      }
      if (item.status === 'calculated' && receipt === undefined && (callId === undefined || callId === '')) {
        const sourceLabel = normalizeProfessionalCandidate(item.source)
        const calculationReceipts = [...state.evidenceReceipts.values()].filter(signedCalculationReceipt)
        const namedReceipts = calculationReceipts.filter(candidate => candidate.operationId !== undefined
          && (sourceLabel === candidate.operationId || sourceLabel.includes(candidate.operationId)))
        if (namedReceipts.length > 1 || (namedReceipts.length === 0 && calculationReceipts.length > 1)) {
          throw new Error(`证据 ${item.id} 同时存在多个本轮受签名计算回执，请把 source 写成准确的操作 ID`)
        }
        receipt = namedReceipts[0] ?? calculationReceipts[0]
      }
      if (item.status === 'calculated' && receipt !== undefined && signedCalculationReceipt(receipt)) {
        canonicalCalculationOperation = receipt.operationId
      }
      if (item.status === 'user-provided' && receipt === undefined && (callId === undefined || callId === '')) {
        const values = (item.values ?? []).map(normalizeProfessionalCandidate).filter(Boolean)
        const sourceLabel = normalizeProfessionalCandidate(item.source)
        const valuesAreInDirectUserInput = values.length > 0
          && values.every(value => evidenceTextIncludesValue(state.userEvidenceText, value))
        if (!valuesAreInDirectUserInput && values.length > 0) {
          let matchingLocalReads = [...state.evidenceReceipts.values()].filter(candidate =>
            customerFileEvidenceTool(candidate.toolName)
            && !signedCalculationReceipt(candidate)
            && values.every(value => evidenceTextIncludesValue(candidate.text, value)),
          )
          matchingLocalReads = distinctLogicalLocalReads(matchingLocalReads)
          if (matchingLocalReads.length === 0 && sourceLabel !== '') {
            // 当同一 evidence 行只有后部某个摘录写错时，不能因为整组自动绑定
            // 失败就退回用户提示词并误报第一项。唯一文件路径只用于选择受信任
            // 读取回执，下面仍会逐项严格校验 values，不会因此放过真实差异。
            matchingLocalReads = distinctLogicalLocalReads(
              [...state.evidenceReceipts.values()].filter(candidate =>
                customerFileEvidenceTool(candidate.toolName)
                && !signedCalculationReceipt(candidate)
                && receiptMatchesSourceLabel(candidate, sourceLabel)),
            )
          }
          if (matchingLocalReads.length > 1) {
            const sourceMatchedReads = matchingLocalReads.filter(candidate =>
              receiptMatchesSourceLabel(candidate, sourceLabel))
            if (sourceMatchedReads.length > 0) matchingLocalReads = sourceMatchedReads
          }
          if (matchingLocalReads.length > 1) {
            throw new Error(`证据 ${item.id} 同时匹配多个本轮客户文件读取回执，请原样填写对应的 toolCallId`)
          }
          receipt = matchingLocalReads[0]
        }
      }
      if (item.status === 'verified' && receipt === undefined) {
        throw new Error(`证据 ${item.id} 标为已核验，但宿主无法根据 sourceUrl、values 或 source 自动绑定本轮受信任工具回执`)
      }
      if (callId !== undefined && callId !== '' && receipt === undefined) {
        throw new Error(`证据 ${item.id} 引用的工具调用 ${callId} 不存在、失败或不属于本轮`)
      }
      if (receipt !== undefined && item.sha256 !== undefined && item.sha256 !== receipt.sha256) {
        throw new Error(`证据 ${item.id} 的摘要与本轮工具输出不一致`)
      }
      const source = receipt === undefined
        ? state.userEvidenceText
        : `${receipt.text}\n洞见宿主访问时间：${receipt.accessedAt}`
      if (item.sourceUrl !== undefined && receipt !== undefined
        && !receipt.sourceUrls.includes(item.sourceUrl) && !source.includes(item.sourceUrl)) {
        throw new Error(`证据 ${item.id} 的来源网址未出现在绑定工具调用或输出中`)
      }
      if (item.status !== 'pending') {
        // 已签名计算回执由宿主生成完整数值集合。忽略模型手抄值，避免格式差异、
        // 遗漏和报告全文扫描再次把可复算任务拖入证据绑定循环。
        const declaredValues = canonicalCalculationOperation === undefined ? item.values ?? [] : []
        for (const value of declaredValues) {
          const normalized = normalizeProfessionalCandidate(value)
          if (!evidenceTextIncludesValue(source, normalized)) {
            const missingRead = item.status === 'user-provided' && receipt === undefined
              && ![...state.evidenceReceipts.values()].some(candidate =>
                customerFileEvidenceTool(candidate.toolName) && !signedCalculationReceipt(candidate))
            throw new Error(`证据 ${item.id} 的取值未出现在绑定来源中：${value}。${missingRead
              ? '当前没有客户文件的受信任读取回执；如事实来自文件，请用 read 或已签名文档读取器读取该文件。Bash 打印内容不能代替读取回执。'
              : '请从已取得的读取结果逐字复制能支撑该事实的短片段，保留原标点；无需复制行号或整行。'}source 显示名称不是读取身份，修改名称不能修复取值不匹配。`)
          }
        }
      }
      return Object.freeze({
        ...item,
        ...(canonicalCalculationOperation === undefined ? {} : { source: canonicalCalculationOperation }),
        ...(receipt === undefined ? {} : {
          toolCallId: receipt.toolCallId,
          sha256: receipt.sha256,
          asOf: receipt.accessedAt,
          values: canonicalCalculationOperation === undefined
            ? [...new Set([...(item.values ?? []), ...evidenceNumberValues(receipt.text), receipt.accessedAt])]
            : [...new Set([...evidenceNumberValues(receipt.text), receipt.accessedAt])],
        }),
      })
    })
    if (sourceText !== undefined) {
      const normalized = normalizeProfessionalCandidate(sourceText)
      const presentInUserInput = normalized !== '' && state.userEvidenceText.includes(normalized)
      const presentInToolOutput = normalized !== ''
        && [...state.evidenceReceipts.values()].some(receipt => receipt.text.includes(normalized))
      if (!presentInUserInput && !presentInToolOutput) {
        throw new Error('sourceText 未绑定本轮用户输入或受信任读取结果')
      }
    }
    return Object.freeze(attested)
  }

  /**
   * Resolve a long humanizer source from one exact trusted local-read receipt.
   * This avoids asking the model to round-trip an entire customer document
   * through JSON while keeping the fact lock bound to this attributed turn.
   * @param exec - Live professional-validation execution.
   * @param toolCallId - Exact call id injected by the Host after read/read_image succeeds.
   * @returns The normalized text captured from that trusted local read.
   */
  sourceTextFromLocalRead(exec: ToolExecution, toolCallId: string): string {
    const state = exec.agent === undefined ? undefined : this.states.get(exec.agent)
    if (state === undefined) throw new Error('gongchuang-policy-gate: no active professional turn')
    const receipt = state.evidenceReceipts.get(toolCallId.trim())
    if (receipt === undefined) {
      throw new Error(`sourceToolCallId ${toolCallId} 不存在、失败或不属于本轮`)
    }
    if (receipt.toolName !== 'read' && receipt.toolName !== 'read_image') {
      throw new Error('sourceToolCallId 必须来自本轮成功的 read 或 read_image')
    }
    return receipt.text
  }

  /**
   * Capture successful trusted source output under its live tool call id.
   * @param exec - Live tool execution carrying the agent and call identities.
   * @param result - Successful result whose normalized text becomes evidence.
   * @returns The immutable receipt recorded for this turn, or undefined when the result is not eligible evidence.
   */
  recordEvidence(
    exec: ToolExecution,
    result: ToolExecutionResult,
  ): Readonly<EvidenceReceipt> | undefined {
    if (exec.agent === undefined || !trustedEvidenceTool(exec.name)) return undefined
    const state = this.states.get(exec.agent)
    if (state === undefined) return undefined
    const text = resultEvidenceText(result)
    if (text === '') return undefined
    const toolCallId = String(exec.callId)
    const operationId = exec.name === 'gongchuang_skill_operation'
      ? signedSkillOperationId(exec.arguments)
      : undefined
    const receipt = Object.freeze({
      toolCallId,
      toolName: exec.name,
      ...(operationId === undefined ? {} : { operationId }),
      sha256: createHash('sha256').update(text).digest('hex'),
      text,
      sourceUrls: invocationSourceUrls(exec.arguments),
      sourcePaths: invocationSourcePaths(exec.arguments),
      accessedAt: new Date().toISOString(),
    })
    state.evidenceReceipts.set(toolCallId, receipt)
    return receipt
  }

  /**
   * Invalidate every content-bound receipt after a formal artifact write.
   * @param exec - File mutation execution whose agent owns the stale receipts.
   */
  invalidateArtifact(exec: ToolExecution): void {
    if (exec.agent === undefined) return
    const state = this.states.get(exec.agent)
    if (state === undefined) return
    state.satisfied.clear()
    state.receiptSubjects.clear()
    delete state.artifactBinding
  }

  /**
   * Return the artifact identity committed by the current turn's professional kernel.
   * @param exec - Live artifact-gate execution owned by the same agent.
   * @returns Immutable content and file identity.
   */
  artifactBinding(exec: ToolExecution): Readonly<ArtifactBinding> {
    const state = exec.agent === undefined ? undefined : this.states.get(exec.agent)
    if (state?.artifactBinding === undefined) throw new Error('洞见交付物尚未通过专业正文校验并绑定文件身份')
    return state.artifactBinding
  }

  /**
   * Return a professional binding when this turn has one; generic file publication has none.
   * @param exec - Live artifact-gate execution whose current-turn state is queried.
   * @returns Immutable content and file identity, or undefined for a generic publication.
   */
  artifactBindingIfPresent(exec: ToolExecution): Readonly<ArtifactBinding> | undefined {
    const state = exec.agent === undefined ? undefined : this.states.get(exec.agent)
    return state?.artifactBinding
  }

  /**
   * Return the exact chat candidate already accepted by the professional kernel.
   * @param exec - Live PDF-export execution owned by the same agent and turn.
   * @returns Exact normalized candidate text bound to the professional receipt.
   */
  professionalSubject(exec: ToolExecution): string {
    const state = exec.agent === undefined ? undefined : this.states.get(exec.agent)
    const subject = state?.receiptSubjects.get(this.professionalReceiptId)
    if (state === undefined || !state.satisfied.has(this.professionalReceiptId) || subject === undefined) {
      throw new Error('PDF 导出前必须先以 chat 模式校验与源文件正文完全一致的候选文本')
    }
    return subject
  }

  /**
   * Return the accepted chat candidate when the current turn has one.
   * Signed Office generators use this optional form so ordinary, non-professional
   * document creation keeps its existing parameter contract.
   * @param exec - Live signed-operation execution owned by the same agent and turn.
   * @returns Exact normalized candidate text when the turn has a professional receipt.
   */
  professionalSubjectIfPresent(exec: ToolExecution): string | undefined {
    const state = exec.agent === undefined ? undefined : this.states.get(exec.agent)
    if (state === undefined || !state.satisfied.has(this.professionalReceiptId)) return undefined
    return state.receiptSubjects.get(this.professionalReceiptId)
  }

  /**
   * Commit or discard every claim bound to one completed execution.
   * @param exec - Completed execution carrying the original claim token.
   * @param acceptedSuccess - Whether execution and all post-execute listeners accepted the result.
   */
  settle(exec: ToolExecution, acceptedSuccess: boolean): void {
    const claim = this.pending.get(exec.token)
    if (claim === undefined) return
    this.pending.delete(exec.token)
    if (!acceptedSuccess || claim.agent !== exec.agent) return
    const state = this.states.get(claim.agent)
    if (state === undefined) return
    if (claim.artifactBinding !== undefined
      && state.artifactBinding?.sha256 !== claim.artifactBinding.sha256) {
      for (const receiptId of state.required.keys()) {
        if (receiptId !== this.professionalReceiptId) state.satisfied.delete(receiptId)
      }
    }
    for (const [receiptId, subject] of claim.receipts) {
      state.satisfied.add(receiptId)
      if (subject !== undefined) state.receiptSubjects.set(receiptId, subject)
    }
    if (claim.artifactBinding !== undefined) state.artifactBinding = Object.freeze({ ...claim.artifactBinding })
    if (claim.professionalLedger !== undefined) state.professionalLedger = claim.professionalLedger
  }
}

function wildcard(pattern: string): RegExp {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`)
  return new RegExp(`^${escaped.replaceAll('*', '.*')}$`)
}

function matches(patterns: readonly RegExp[], value: string): boolean {
  return patterns.some(pattern => pattern.test(value))
}

const AMBIGUOUS_PROFESSIONAL_MARKERS = new Set([
  '体检', '评分', '测评', '打分', '出报告', '生成报告', '报告文件', '行业分析', '标准',
])

const PROFESSIONAL_SUBJECT_MARKERS = [
  '企业', '公司', '政府项目', '申报项目', '科技项目', '项目申报', '政策', '申报',
  '高企', '专精特新', '小巨人', '专利', '知识产权', '财务', '税务', '同行',
  '工商', '统一社会信用代码', '市场份额', '市场占有率',
]

const SCOPED_ANALYSIS_MARKERS = [
  '分析', '评估', '对比', '核验', '判断', '测算', '审查', '审核', '诊断', '适配',
  '检索', '查一下', '帮我查', '看看', '建议', '怎么改', '如何改',
]

const EXPLICIT_SCOPE_LIMIT_MARKERS = [
  '这一栏', '这一段', '该栏', '该段', '单项', '仅就', '只就', '只回答', '只分析',
  '只判断', '只评估', '只修改', '只改', '仅分析', '仅判断', '仅评估', '仅修改',
  '不要展开', '不展开', '无需完整', '不做完整',
]

function responseDepthForText(text: string): ProfessionalResponseDepth {
  const namesFormalArtifact = containsActionableAny(text, [
    '报告', '申请书', '正式材料', '提交稿', 'Word', 'PDF', 'Excel', 'PPT',
    'DOCX', 'docx', 'XLSX', 'xlsx', 'XLSM', 'xlsm', 'PPTX', 'pptx', 'HTML', 'html',
  ])
  const requestsFormalAction = containsActionableAny(text, [
    '撰写', '生成', '形成', '出具', '制作', '交付', '回填', '扩表', '核稿',
  ])
  const explicitlyScoped = containsActionableAny(text, EXPLICIT_SCOPE_LIMIT_MARKERS)
  if (!explicitlyScoped && ((namesFormalArtifact && requestsFormalAction)
    || containsActionableAny(text, ['出报告', '给公司出报告', '给企业出报告']))) return 'formal'
  return containsActionableAny(text, SCOPED_ANALYSIS_MARKERS) ? 'analysis' : 'query'
}

const ENTERPRISE_PANORAMA_SKILL = 'enterprise-panorama-analysis'

function hasEnterprisePanoramaMode(text: string): boolean {
  return /(?:第一版|标准销售版|第二版|GCIP\s*深度顾问版|深度顾问版|两版|全部生成|全生成)/iu.test(text)
    || /(?:^|[\s，,。；;：:])(?:A|B|C)(?=$|[\s，,。；;：:])/iu.test(text)
}

function asksForEnterprisePanoramaMode(text: string): boolean {
  return /(?:请选择|请回复|选择报告模式|确认报告模式)/u.test(text)
    && /(?:A|B|C|标准销售版|深度顾问版|全生成)/iu.test(text)
}

function refreshEnterprisePanoramaMode(state: ActiveDeliveryState): void {
  state.awaitingEnterprisePanoramaMode = state.contractSkills.has(ENTERPRISE_PANORAMA_SKILL)
    && !hasEnterprisePanoramaMode(state.userEvidenceText)
}

function modelToolNamesFromCode(value: unknown): readonly string[] {
  const args = objectRecord(value)
  if (typeof args?.code !== 'string') return []
  return [...args.code.matchAll(/tools(?:\.([A-Za-z0-9_]+)|\[\s*['"]([^'"]+)['"]\s*\])/gu)]
    .map(match => match[1] ?? match[2])
    .filter((name): name is string => name !== undefined)
}

function isProfessionalChoiceSetupTool(exec: ToolExecution): boolean {
  if (exec.name === 'skill' || exec.name === 'ask_user_question') return true
  if (exec.name !== 'run_code') return false
  const names = modelToolNamesFromCode(exec.arguments)
  return names.length > 0 && names.every(name => name === 'skill' || name === 'ask_user_question')
}

function markerGroupsForDepth(
  rule: ProfessionalSkillRule,
  depth: ProfessionalResponseDepth,
): readonly (readonly string[])[] {
  if (depth === 'formal') return rule.requiredMarkerGroups
  if (depth === 'analysis') return rule.analysisMarkerGroups ?? []
  return rule.queryMarkerGroups ?? []
}

function containsProfessionalBusinessDomain(text: string, markers: readonly string[]): boolean {
  const hasProfessionalSubject = containsActionableAny(text, PROFESSIONAL_SUBJECT_MARKERS)
  return markers.some(marker => containsActionableMarker(text, marker)
    && (!AMBIGUOUS_PROFESSIONAL_MARKERS.has(marker) || hasProfessionalSubject))
}

function deliveryRuleMatches(rule: DeliveryRule, text: string): boolean {
  if (rule.id !== 'formal-artifact') return containsActionableAny(text, rule.triggerAny)
  // A filename extension identifies a format, not the user's intent. Bare
  // `.docx`/`.pdf` mentions are common when importing, reading or OCRing an
  // existing customer file. Creation is still caught by explicit signed
  // phrases (生成、交付、出报告等) and by actual file-mutation tools.
  const signedPhraseMatches = containsActionableAny(
    text,
    rule.triggerAny.filter(marker => !FORMAL_ARTIFACT_EXTENSION_MARKERS.has(marker.toLowerCase())),
  )
  if (signedPhraseMatches) return true
  const lowerText = text.toLowerCase()
  const namesOutputFormat = [...FORMAL_ARTIFACT_EXTENSION_MARKERS]
    .some(marker => lowerText.includes(marker) || lowerText.includes(marker.replace(/^\./u, '')))
  return namesOutputFormat
    && containsActionableAny(text, ['生成', '创建', '制作', '导出', '交付'])
}

function addSkillWithDependencies(
  target: Set<string>,
  name: string,
  dependencies: ProfessionalContracts['dependencies'],
  visiting = new Set<string>(),
): void {
  if (visiting.has(name)) throw new Error(`gongchuang-policy-gate: professional dependency cycle at ${name}`)
  if (target.has(name)) return
  visiting.add(name)
  target.add(name)
  for (const dependency of dependencies.get(name) ?? []) {
    addSkillWithDependencies(target, dependency, dependencies, visiting)
  }
  visiting.delete(name)
}

function activateProfessionalRules(
  state: ActiveDeliveryState,
  contracts: ProfessionalContracts,
  userText: string,
): void {
  // Domain markers choose the owning skill; they do not imply report depth.
  // Keep depth fixed from the user's requested action so a word such as
  // "企业画像" inside a scoped question cannot impose the formal contract.
  state.responseDepth = responseDepthForText(userText)
  // 抄录附件与注释不等于重新分析被引用的业务。保留用户真正提出的
  // 判断/制作要求，但不要仅因待核验状态或旧任务名称再次启动专业链。
  const extractsExistingText = /(?:仅回复|只回复|只回答|抄录|摘录|原样)[^。！？\n]*(?:原文|字段|数字|文件名)/u.test(userText)
  if (state.responseDepth === 'query' && extractsExistingText) return
  const explicitlyNamedSkills = [...contracts.skills.keys()].filter(name => userText.includes(name))
  const matched: string[] = []
  for (const [name, rule] of contracts.skills) {
    // 用户精确写出技能 ID 时，该 ID 就是本轮主任务选择。不再让
    // “前期评估”等通用词又把另一个业务技能叠加成第二套正文合同。
    if (explicitlyNamedSkills.length > 0 && !explicitlyNamedSkills.includes(name)) continue
    // 用户直接写出签名技能 ID 时已经完成了精确路由选择。若仍要求同时
    // 命中中文触发词，显式选择会先退回 project-task-router，直到首次
    // 专业校验才发现多余依赖，白白增加一轮模型调用。
    if (!explicitlyNamedSkills.includes(name)
      && !containsActionableAny(userText, rule.appliesWhenPromptContains)) continue
    // Some signed skills are useful in ordinary assistant work too.  A user
    // asking to make a daily note sound more natural may use the humanizer,
    // but that alone must not turn the whole turn into a government-project
    // evidence workflow.  Standalone strict routing belongs to the explicit
    // professional roster; advisory skills join once a professional business
    // subject has otherwise been established.
    if (!contracts.routeResolutionSkills.has(name)
      && !containsProfessionalBusinessDomain(userText, contracts.businessDomainMarkers)) continue
    matched.push(name)
    state.markerGroups.set(name, markerGroupsForDepth(rule, state.responseDepth))
  }
  if (matched.length === 0) {
    if (containsActionableAny(userText, contracts.peerTaskMarkers)) matched.push('peer-benchmarking')
    if (containsActionableAny(userText, contracts.policyTaskMarkers)) matched.push('policy-retrieval')
    if (containsProfessionalBusinessDomain(userText, contracts.businessDomainMarkers)) {
      matched.push('project-task-router')
      state.requiresSpecificRoute = true
    }
  }
  for (const name of matched) {
    state.contractSkills.add(name)
    const rule = contracts.skills.get(name)
    if (rule !== undefined) state.markerGroups.set(name, markerGroupsForDepth(rule, state.responseDepth))
  }
  for (const name of matched) addSkillWithDependencies(state.professionalSkills, name, contracts.dependencies)
}

function activateDeliveryRule(state: ActiveDeliveryState, rule: DeliveryRule): void {
  for (const receipt of rule.receipts) state.required.set(receipt.id, receipt)
}

function activateFormalDelivery(
  state: ActiveDeliveryState,
  contracts: ProfessionalContracts,
  policy: SignedPolicyManifest,
): void {
  const rule = policy.delivery.rules.find(candidate => candidate.id === 'formal-artifact')
  if (rule === undefined) throw new Error('gongchuang-policy-gate: signed formal-artifact rule is missing')
  activateDeliveryRule(state, rule)
  if (state.professionalSkills.size === 0) {
    addSkillWithDependencies(state.professionalSkills, 'project-task-router', contracts.dependencies)
    state.requiresSpecificRoute = true
  }
  state.required.set(policy.delivery.professionalReceipt.id, policy.delivery.professionalReceipt)
}

function isFormalArtifactMutation(exec: ToolExecution): boolean {
  if (exec.name.startsWith('gongchuang_')) return false
  return exec.name === 'write' || exec.name === 'edit' || exec.name === 'apply_patch'
    || exec.name.startsWith('write') || exec.name.startsWith('edit')
}

function invokedSkillNames(messages: readonly { readonly source: { readonly kind: string } }[]): string[] {
  const rows: string[] = []
  for (const message of messages) {
    if (message.source.kind !== 'skill-invocation') continue
    const name = (message.source as { readonly name?: unknown }).name
    if (typeof name === 'string') rows.push(name)
  }
  return rows
}

function deliveryProfileContractNotice(
  profileId: string,
  profile: ProfessionalDeliveryProfile,
): string {
  const sections = profile.requiredSections.length > 0
    ? profile.requiredSections.join(' → ')
    : '无'
  const tables = profile.requiredTables.length > 0
    ? profile.requiredTables.map((table) => {
      const rowRequirement = table.minRows > 0 ? `；至少 ${String(table.minRows)} 行正文数据` : ''
      return `${table.id}[列：${table.requiredColumns.join('、')}${rowRequirement}]`
    }).join('；')
    : '无'
  const requirements = [
    profile.requiresSourceTrace ? '来源追溯' : undefined,
    profile.requiresEvidenceLedger ? '证据台账' : undefined,
    profile.requiresPeerComparison ? '同行对比' : undefined,
    profile.requiresPolicySelectionTrace ? '政策选择链' : undefined,
    profile.requiresFourQuestionReview ? '任务结束四问' : undefined,
  ].filter((value): value is string => value !== undefined)
  return [
    `${profileId} 必备章节（按顺序）：${sections}。`,
    `${profileId} 必备表格：${tables}。`,
    `${profileId} 允许格式：${[...profile.artifactFormats].sort().join('、') || '无'}；`
      + `附加要求：${requirements.join('、') || '无'}。`,
  ].join('\n')
}

function skillOutputContractNotice(
  contracts: ProfessionalContracts,
  name: string,
  depth: ProfessionalResponseDepth,
): string | undefined {
  const rule = contracts.skills.get(name)
  const groups = rule === undefined ? [] : markerGroupsForDepth(rule, depth)
  const rows: string[] = []
  if (groups.length > 0) {
    rows.push(
      `${name} 标记规则：每个方括号是一组备选标记，组内只需原样出现任意一个；`
      + '各组必须按编号顺序出现在 candidateText 中。斜杠只表示“或”，不要输出斜杠，也不要把组内备选词连写。',
      `${name} 强制正文顺序：${groups
        .map((group, index) => `${String(index + 1)}.[${group.join(' / ')}]`)
        .join(' → ')}。`,
    )
  }
  if (name === 'peer-benchmarking') {
    rows.push(
      '同行证据分类：政府公示名单用 kind=official-list；政府官网文章或通知用 kind=government-source 或 official-policy；企业官网原文用 kind=enterprise-official。以上都必须 status=verified 并绑定本轮受信任工具回执。',
    )
  }
  const profiles = [...contracts.deliveryProfiles]
    .filter(([, profile]) => profile.skillId === name)
    .sort(([left], [right]) => left.localeCompare(right))
  const profileIds = profiles.map(([id]) => id)
  if (profileIds.length > 0) {
    rows.push(
      `${name} 的正式文件 deliveryProfileId 只能从以下签名画像中选择：${profileIds.join('、')}。`
      + '按本轮报告类型或版本选择对应 ID，不得猜测或改写。',
      // 让模型在生成 Office 文件前就拿到签名画像的精确结构，
      // 避免文件已生成后才由 artifact 校验暴露缺章或缺列。
      ...profiles.map(([profileId, profile]) => deliveryProfileContractNotice(profileId, profile)),
    )
  } else if (rule !== undefined) {
    rows.push(`${name} 没有自有签名交付画像；以该技能为主任务校验时省略 deliveryProfileId，不借用其他技能的 ID。`)
  }
  return rows.length > 0 ? rows.join('\n') : undefined
}

const PROFESSIONAL_TOOL_TRANSPORT_NOTICE = '工具调用通道：以下 skill、ask_user_question、已签名技能操作和专业校验均使用当前工具目录。当前只开放 run_code 时，必须在其程序内 await tools.skill({name: "技能名"})，其余工具同样通过 tools 调用；不要直接调用未开放的根工具。run_code 不是 Node.js 模块，而是 V8 隔离程序：不得写 require(...)、import、process、fs 或网络访问，只能调用当前暴露的 tools；已签名输出操作会自行创建父目录，无需 mkdir。禁止探查运行环境、列目录或临时编写 Node/Python Office 生成脚本。run_code 最终只返回 null 或显式构造的字符串、数字、布尔值与纯 JSON 对象；不得返回原始工具结果或含 undefined 的字段。'

function professionalNotice(
  state: ActiveDeliveryState,
  contracts: ProfessionalContracts,
  version: string,
): string {
  const skills = [...state.professionalSkills].sort()
  const contractSkills = [...state.contractSkills].sort()
  const skillContracts = contractSkills
    .map(skill => skillOutputContractNotice(contracts, skill, state.responseDepth))
    .filter((notice): notice is string => notice !== undefined)
  const depthNotice = state.responseDepth === 'formal'
    ? '本轮是正式交付：按已选业务模式完成完整结构与文件验收。'
    : state.responseDepth === 'analysis'
      ? '本轮是局部分析：只展开用户明确提出的判断范围，不自动追加完整项目评估、企业画像、评分、材料清单或报告文件。'
      : '本轮是单点查询：直接给出最短充分答案，不自动扩展为完整分析、报告或申报工作流。'
  return [
    `洞见专业执行链已锁定技能包 V${version}。`,
    `本任务必须激活并遵循：${skills.join('、')}。第一步逐项调用 skill 激活这里列出的全部技能，确认全部成功后再读取资料、起草或校验；不得等校验器提示遗漏后补激活。`,
    PROFESSIONAL_TOOL_TRANSPORT_NOTICE,
    depthNotice,
    ...(state.responseDepth !== 'formal' && !contractSkills.includes('policy-retrieval') && isUserRuleCalculation(state.userEvidenceText) ? [
      '本轮只按用户给定规则核算，不作现实政策资格判断。政策检索仅为技能支持依赖，不要求另取官方政策；计算及原始事实仍须校验，正文须声明不构成申报资格结论，不得扩大为可申报或可获补贴。',
    ] : []),
    ...(state.responseDepth !== 'formal' && contractSkills.includes('peer-benchmarking')
      && !contractSkills.includes('policy-retrieval') && isProvidedDataComparison(state.userEvidenceText) ? [
        '本轮仅比较用户指定的输入样本，不要求为样本内部排序另取政府或企业官网证据。原始事实和复算仍须绑定，正文须明确样本范围；不得扩大为真实行业排名、市场份额或申报资格结论。',
      ] : []),
    '报告文件格式规则：每份报告正文只生成一次；用户未明确指定文件格式时只交付一份 DOCX，不同时生成同一正文的 PDF。只有用户明确要求 PDF 时才启用 PDF 渲染，HTML 只作为不发布的中间源；不同业务报告模式仍按主技能规则选择。Office 任务先用尚未写入文件的完整 candidateText 做 chat 预校验；预校验返回 formal 或明确允许待完善文件继续后才生成文件。禁止先生成 DOCX 再用 pandoc、解压 XML 或自编脚本回读作为 chat 预校验。',
    '用户决策规则：专业 Skill 要求用户选择报告模式、版本或其他不可代答选项时，必须先调用 ask_user_question 并等待真实回答；不得只发一条普通提问后在同一轮继续，也不得自行采用推荐项或第一项。',
    `这些技能的事实边界、计算口径、证据要求和质量门禁都是强制条件；正文结构只采用任务主技能：${contractSkills.join('、') || '等待专业路由技能激活'}。支持依赖不得叠加第二套输出模板。证据不足时保留待核验或暂无法判断，不得回退为通用模型自由发挥。`,
    ...skillContracts,
    '证据绑定规则：用户在对话中直接提供的事实标为 user-provided，values 逐字复制用户消息；通过 read/read_image、已签名客户文件提取操作或 PaddleOCR MCP 提取的客户文件事实也标为 user-provided，values 逐字复制读取结果。签名技能参考文件不是客户文件：其中列示的政府政策用于政策结论时，必须使用 kind=official-policy、status=verified，sourceUrl 使用该读取回执中的 gov.cn 原文网址，values 逐字复制同一回执内容；不得因为它由 read 读取就标为 user-provided。宿主会自动绑定唯一匹配的读取回执；只有多个读取结果含有相同取值时，才从洞见证据回执原样复制 toolCallId。已签名确定性计算或 run-preflight 操作只使用一条 calculated 证据，source 写准确操作 ID，values 省略或写空数组；宿主会直接绑定并生成全部数值，不得扫描成品全文、逐页枚举数字或手抄 calculations。回执 accessedAt 只填 evidence.asOf，不得放入 values。',
    '技能脚本规则：gongchuang_skill_operation 是针对工作区内已有文件的受签名固定操作，不是每个对话任务的必经步骤；但主技能明确提供生成或计算操作时必须优先使用。禁止猜测操作 ID、禁止传入空路径。用户要求“只在对话中输出”或“不创建文件”，且工作区没有已有的结构化校验文件时，不得为调用该工具创建临时文件；直接使用 gongchuang_professional_validate 完成本轮必需的专业门禁。确需校验已有文件时，只能使用工具说明或已验签 client-runtime-operations.json 中逐字列出的操作 ID 与参数名。',
    '最小充分执行规则：已成功取得的客户文件、网页原文、证据回执、计算结果和技能正文都是本轮检查点。除非调用失败、来源时点变化或新证据冲突，不得重复读取或检索；不得为了计算候选长度、确认内容或准备生成文件而再次读取同一输入，直接复用内存中的 candidateText。不要调用 Bash、wc 或脚本预先统计正文的字符数或字节数；text 长度由宿主按字符串 length 校验，直接提交一次并只在工具明确返回超限时修正。校验失败时保留 candidateText、evidence 与 calculations，只修复错误清单列出的缺口。',
    'Office 正式交付规则：当所选专业 Skill 声明 deliveryProfileId 时，生成 DOCX、XLSX 或 PPTX 前先以 chat 模式提交完整结构候选与该 deliveryProfileId 做专业预校验；预校验通过后才生成一个正式文件。主技能有专用模板或生成操作时必须使用；主技能没有专用 DOCX 模板或生成操作时，必须在同一个 run_code 中完成预校验后立即调用已签名操作 evidence-ledger.create-docx，content 传当前 candidateText 变量，output 传工作区内尚不存在的 .docx 路径。宿主会直接注入刚通过的正文检查点，不得在校验后重新拼接、转述或手抄正文。不得临时编写 Node/Python 生成脚本，不得使用 pandoc 或 OOXML 解压回读替代该操作。生成文件不添加客户端品牌页眉、标志或水印。随后以 artifact 模式对真实文件校验，并完成文档标识、正文、可打开性与适用的视觉检查。',
    'PDF 正式交付规则：不得把 HTML 预稿冒充最终 PDF，也不得先用 artifact 模式绑定不属于交付画像的源格式。先以 chat 模式传入 candidateArtifactPath，让宿主从真实静态 HTML 源文件提取正文并完成专业预校验；不得由模型重新抄写整份源正文。再调用 gongchuang_render_pdf 生成同目录 PDF；该动作会使预校验回执失效。随后必须以 artifact 模式从真实 PDF 重新完成专业校验，再依次完成可打开性、正文一致性、文档标识与逐页视觉验收。Office 文件保持原生 OOXML，不作为 PDF 转换源。',
    '最终输出规则：已锁定专业 Skill 且只在对话中交付正文的专业任务，在 gongchuang_professional_validate 通过后，下一条最终消息只能逐字输出本次 candidateText。正式文件流程必须继续完成生成、artifact 校验与全部交付回执，最终只返回已绑定的正式文件，不得添加校验状态、哈希或证据条数。',
  ].join('\n')
}

function newlyRequiredSkillNotice(
  state: ActiveDeliveryState,
  contracts: ProfessionalContracts,
  professionalReceiptId: string,
): string | undefined {
  const newlyRequired = [...state.professionalSkills]
    .filter(skill => !state.notifiedProfessionalSkills.has(skill))
    .filter(skill => !state.activatedSkills.has(skill))
    .sort()
  if (newlyRequired.length === 0) return undefined
  for (const skill of newlyRequired) state.notifiedProfessionalSkills.add(skill)
  const validatedSubject = state.receiptSubjects.get(professionalReceiptId)
  return [
    `刚激活的技能展开了新的 V${contracts.ruleVersion} 必需依赖：${newlyRequired.join('、')}。`,
    PROFESSIONAL_TOOL_TRANSPORT_NOTICE,
    validatedSubject === undefined
      ? '必须先逐项调用 skill 激活上述依赖，再构造或提交 gongchuang_professional_validate。'
      : `专业正文内容校验已通过；${candidateCheckpoint(validatedSubject)}`,
    validatedSubject === undefined
      ? undefined
      : '必须先逐项调用 skill 激活上述依赖；不要重新提交专业校验、重写或重复输出候选正文。',
    '复用当前轮次已经成功取得的文件、网页、证据回执和计算结果；不要重新检索、重新读取或从头重写候选。',
  ].filter((row): row is string => row !== undefined).join('\n')
}

function activateSkill(state: ActiveDeliveryState, name: string): void {
  state.activatedSkills.add(name)
  state.activationSequence.push(name)
}

function activateObservedSkill(
  state: ActiveDeliveryState,
  contracts: ProfessionalContracts,
  name: string,
): void {
  activateSkill(state, name)
  if (!contracts.routeResolutionSkills.has(name) && !contracts.skills.has(name)) return
  const hadProfessionalRoute = state.professionalSkills.size > 0
  // 总控也拥有通用文档读取器。加载它不等于用户要求开始专业业务；
  // 专业意图或随后加载的具体领域技能仍会正常锁定校验链。
  if (!hadProfessionalRoute && (name === 'project-application-assistant' || name === 'project-task-router')) return
  // A general-purpose advisory skill (for example natural-language polish)
  // is allowed to run in an ordinary turn without retrospectively activating
  // the strict professional validator.  It becomes part of the strict chain
  // only after the current turn has already matched a professional route.
  if (!contracts.routeResolutionSkills.has(name) && !hadProfessionalRoute) return
  addSkillWithDependencies(state.professionalSkills, name, contracts.dependencies)
  const rule = contracts.skills.get(name)
  if ((state.requiresSpecificRoute || !hadProfessionalRoute) && name !== 'project-task-router') {
    state.contractSkills.add(name)
    if (rule !== undefined) state.markerGroups.set(name, markerGroupsForDepth(rule, state.responseDepth))
    state.requiresSpecificRoute = false
  }
}

function qualityGateOrderProblems(
  state: ActiveDeliveryState,
  contracts: ProfessionalContracts,
): string[] {
  const problems: string[] = []
  for (const source of state.professionalSkills) {
    const sourceIndex = state.activationSequence.lastIndexOf(source)
    if (sourceIndex < 0) continue
    for (const gate of contracts.qualityGates.get(source) ?? []) {
      const gateIndex = state.activationSequence.lastIndexOf(gate)
      if (gateIndex <= sourceIndex) problems.push(`${source} → ${gate}（质量门禁必须在专业处理后重新执行）`)
    }
  }
  return problems
}

function latestAssistantText(agent: Agent, turn: number): string {
  const event = agent.session.snapshotEvents()
    .findLast(candidate => candidate.type === 'assistant/message' && candidate.data.turn === turn)
  if (event?.type !== 'assistant/message') return ''
  return event.data.message.content
    .map(block => block.type === 'text' ? block.text : '')
    .join('\n')
}

function candidateCheckpoint(subject: string): string {
  return `已保留候选正文（${String(subject.length)} 字符），无需重新提交或重写。`
}

function professionalFailureIssues(error: unknown): string[] {
  const message = error instanceof Error ? error.message : String(error)
  const lines = message.split('\n')
    .map(line => line.replace(/^\s*-\s*/u, '').trim())
    .filter(line => line !== ''
      && line !== '洞见专业校验未通过：'
      && !line.startsWith('洞见最小充分修复：'))
  return lines.length === 0 ? ['专业校验未返回可读诊断'] : [...new Set(lines)]
}

function professionalFailureStatus(error: unknown): 'draft' | 'failed' {
  const message = error instanceof Error ? error.message : String(error)
  return /(?:候选安装包未绑定可信|当前专业会话没有企业空间|交付物未提供可审计正文|可信 PDF .*不一致|ENOENT|EACCES|EPERM|文件.*(?:损坏|不可读取))/iu.test(message)
    ? 'failed'
    : 'draft'
}

function explicitlyAllowsTerminalPolicyDraft(
  userRequest: string,
  candidateText: string,
  issues: readonly string[],
): boolean {
  const substantiveIssues = issues.filter(issue => issue.trim() !== '')
  const onlyPolicyEvidenceIsMissing = substantiveIssues.length > 0
    && substantiveIssues.every(issue => /(?:政策选择链与官方原文|政策结论缺少政府官网或已校验锁定的官方原文)/u.test(issue))
  if (!onlyPolicyEvidenceIsMissing) return false

  const requestsDraft = /(?:草稿|初稿|待完善|待补|draft)/iu.test(userRequest)
  const chinesePolicyUnavailable = /政策(?:原文|依据|来源|文件)?[^\n。！？]{0,48}(?:无法|不能|未能|未取得|未核验|待核验)/u
  const englishPolicyUnavailable = new RegExp(
    String.raw`(?:official\s+)?polic(?:y|ies)[^.\n]{0,80}`
      + String.raw`(?:cannot|can't|unable|unavailable|not\s+(?:be\s+)?verified)`,
    'iu',
  )
  const saysPolicyCannotBeVerified = chinesePolicyUnavailable.test(userRequest)
    || englishPolicyUnavailable.test(userRequest)
  const sourceScopeExplainsPolicyGap = new RegExp([
    String.raw`不联网|仅限[^\n。！？]{0,64}(?:资料|文件|来源)|do\s+not\s+use\s+(?:the\s+)?web`,
    String.raw`(?:evidence|sources?)\s+(?:is|are)\s+limited`,
  ].join('|'), 'iu').test(userRequest)
    && new RegExp([
      String.raw`政策[^\n。！？]{0,64}(?:缺口|未提供|待核验|不得补造)`,
      String.raw`polic(?:y|ies)[^.\n]{0,80}(?:gap|not\s+provided|do\s+not\s+invent|pending)`,
    ].join('|'), 'iu').test(userRequest)
  const candidateDisclosesDraft = /(?:草稿|初稿|待完善|待核验|暂无法判断|不作为正式)/u.test(candidateText)
  return requestsDraft && (saysPolicyCannotBeVerified || sourceScopeExplainsPolicyGap) && candidateDisclosesDraft
}

function draftArtifactCopy(path: string): string {
  const source = inspectProfessionalArtifact(path)
  if (basename(source.path).includes('待完善')) return source.path
  const suffix = extname(source.path)
  const stem = basename(source.path, suffix)
  for (let index = 0; index < 1_000; index += 1) {
    const discriminator = index === 0 ? '' : `-${String(index + 1)}`
    const candidate = join(dirname(source.path), `${stem}（待完善${discriminator}）${suffix}`)
    if (existsSync(candidate)) {
      try {
        if (inspectProfessionalArtifact(candidate).sha256 === source.sha256) return candidate
      } catch {
        // A stale or unreadable path must not be overwritten; try the next name.
      }
      continue
    }
    copyFileSync(source.path, candidate)
    const copied = inspectProfessionalArtifact(candidate)
    if (copied.sha256 !== source.sha256) throw new Error('待完善稿复制后文件身份不一致')
    return copied.path
  }
  throw new Error('无法为待完善稿分配安全文件名')
}

/**
 * Close an unused repair window without asking the model to decide whether it
 * has wandered long enough.  One model step is the complete automatic repair
 * budget; a following step means no repaired candidate was resubmitted.
 */
function closeExpiredProfessionalRepair(state: ActiveDeliveryState): void {
  const issues = state.professionalRepairIssues.length > 0
    ? [...state.professionalRepairIssues]
    : ['本轮唯一一次自动修正未重新提交可校验候选']
  const originalArtifactPath = state.professionalRepairArtifactPath
  let artifactPath: string | undefined
  if (originalArtifactPath !== undefined) {
    try {
      artifactPath = draftArtifactCopy(originalArtifactPath)
    } catch (error: unknown) {
      state.terminalOutcome = Object.freeze({
        status: 'failed',
        issues: Object.freeze([...issues, ...professionalFailureIssues(error)]),
        originalArtifactPath,
      })
      state.phase = 'failed'
      state.professionalRepairPending = false
      state.professionalRepairWriteRetryUsed = false
      delete state.professionalRepairWriteRetryPath
      return
    }
  }
  state.terminalOutcome = Object.freeze({
    status: 'draft',
    issues: Object.freeze(issues),
    ...(state.professionalRepairCandidateText === undefined
      ? {}
      : { candidateText: state.professionalRepairCandidateText }),
    ...(artifactPath === undefined ? {} : { artifactPath }),
    ...(originalArtifactPath === undefined ? {} : { originalArtifactPath }),
  })
  state.phase = 'draft'
  state.professionalRepairPending = false
  state.professionalRepairWriteRetryUsed = false
  delete state.professionalRepairWriteRetryPath
}

function missingMarkerGroups(state: ActiveDeliveryState, answer: string): string[] {
  const missing: string[] = []
  for (const [skill, groups] of state.markerGroups) {
    let cursor = 0
    for (const [groupIndex, group] of groups.entries()) {
      const matches = group
        .map(marker => ({ marker, index: answer.indexOf(marker, cursor) }))
        .filter(match => match.index >= 0)
        .sort((left, right) => left.index - right.index)
      const match = matches[0]
      if (match === undefined) {
        const existsEarlier = group.some(marker => answer.includes(marker))
        missing.push(
          `${skill} 第 ${String(groupIndex + 1)} 组：任选一个标记 ${group.join('、')}`
          + (existsEarlier ? '（顺序错误：已出现但位于前一组之前）' : '（缺少）'),
        )
        continue
      }
      cursor = match.index + match.marker.length
    }
  }
  return missing
}

function assertArtifactMatchesBinding(
  binding: Readonly<ArtifactBinding>,
  inspection: ProfessionalArtifactInspection,
): void {
  if (inspection.path !== binding.path || inspection.format !== binding.format || inspection.sha256 !== binding.sha256) {
    throw new Error('洞见交付物与本轮专业校验绑定的文件身份不一致')
  }
}

async function resolveArtifactContent(
  ctx: Context,
  inspection: ProfessionalArtifactInspection,
  workspaceRoot?: string,
): Promise<{ text: string; sha256: string }> {
  if (inspection.contentText !== undefined) {
    const text = normalizeProfessionalCandidate(inspection.contentText)
    return { text, sha256: createHash('sha256').update(text).digest('hex') }
  }
  if (inspection.format !== 'pdf') throw new Error('交付物未提供可审计正文')
  const renderer = ctx.get('gongchuangArtifactRenderer')
  if (renderer === undefined) throw new Error('候选安装包未绑定可信 PDF 正文解析器；PDF 专业校验保持关闭')
  if (workspaceRoot === undefined) throw new Error('当前专业会话没有企业空间，PDF 专业校验保持关闭')
  const receipt = parsePdfInspectionReceipt(await renderer.inspectPdf({
    artifactPath: inspection.path,
    artifactSha256: inspection.sha256,
    workspaceRoot,
  }))
  if (receipt.artifactSha256 !== inspection.sha256 || receipt.pageCount !== inspection.units) {
    throw new Error('可信 PDF 正文回执与文件身份或页数不一致')
  }
  return { text: receipt.contentText, sha256: receipt.contentSha256 }
}

function professionalWorkspaceRoot(exec: ToolExecution): string {
  const cwd = exec.agent?.session.header.cwd
  if (cwd === undefined) throw new Error('当前专业会话没有企业空间，宿主文档能力保持关闭')
  return resolve(cwd)
}

function professionalArtifactPath(exec: ToolExecution, value: string): string {
  const path = value.trim()
  if (path === '') throw new Error('专业产物路径不能为空')
  // DSH 模型会合法地传入相对当前企业空间的文件路径。若交给 node:path.resolve
  // 使用宿主进程目录，安装包内会错解析到系统根目录并以 ENOENT 终止。
  return isAbsolute(path) ? resolve(path) : resolve(professionalWorkspaceRoot(exec), path)
}

interface ProfessionalArtifactGateTarget {
  status: 'formal' | 'draft'
  inspection: ProfessionalArtifactInspection
  binding?: Readonly<ArtifactBinding>
  candidateText?: string
}

function professionalArtifactGateTarget(
  state: ActiveDeliveryState | undefined,
  binding: Readonly<ArtifactBinding> | undefined,
  exec: ToolExecution,
  requestedPath: string,
): ProfessionalArtifactGateTarget | undefined {
  if (binding !== undefined) {
    const inspection = inspectProfessionalArtifact(professionalArtifactPath(exec, requestedPath))
    assertArtifactMatchesBinding(binding, inspection)
    return { status: 'formal', inspection, binding }
  }
  const terminal = state?.terminalOutcome
  if (terminal?.status !== 'draft' || terminal.artifactPath === undefined
    || terminal.originalArtifactPath === undefined) return undefined
  const requested = professionalArtifactPath(exec, requestedPath)
  const original = professionalArtifactPath(exec, terminal.originalArtifactPath)
  const draft = professionalArtifactPath(exec, terminal.artifactPath)
  if (requested !== original && requested !== draft) {
    throw new Error('待完善终态只允许检查宿主返回的待完善副本，不得切换到其他文件')
  }
  // 终态草稿不是正式回执，但也不是未校验的中间文件。后续检查必须统一
  // 重定向到宿主复制并标名的副本，否则有界结束会再次退化成工具错误或误发原稿。
  return {
    status: 'draft',
    inspection: inspectProfessionalArtifact(draft),
    ...(terminal.candidateText === undefined ? {} : { candidateText: terminal.candidateText }),
  }
}

function explicitlyContinuesProfessionalTask(text: string): boolean {
  const normalized = normalizeProfessionalCandidate(text).replace(/[。.!！]+$/gu, '').trim()
  return /^(?:继续|继续处理|继续完成|继续上次任务|恢复|恢复任务|从断点继续)$/u.test(normalized)
}

async function persistDeliveryState(
  store: ProfessionalTaskCheckpointStore,
  agent: Agent,
  state: ActiveDeliveryState,
  publishNotice = true,
): Promise<void> {
  if (state.professionalSkills.size === 0 && state.terminalOutcome === undefined) return
  await store.write({
    schemaVersion: 1,
    sessionId: String(agent.session.id),
    contractVersion: state.contractVersion,
    taskStartSeq: state.taskStartSeq,
    phase: state.phase,
    updatedAt: new Date().toISOString(),
    payload: serializeDeliveryState(state),
  })
  // 工具执行期间只持久化检查点。此时插入用户通知会隔开 assistant.tool_calls
  // 与工具结果，导致兼容 OpenAI 的提供方返回 400。下一次 pre-step 或停止边界再显示。
  if (!publishNotice) return
  const paths = [...state.formalArtifactPaths]
  if (state.artifactBinding !== undefined && !paths.includes(state.artifactBinding.path)) paths.push(state.artifactBinding.path)
  if (paths.length === 0 && state.terminalOutcome?.originalArtifactPath !== undefined) {
    paths.push(state.terminalOutcome.originalArtifactPath)
  }
  const phase = state.terminalOutcome?.status ?? state.phase
  const terminal = phase === 'draft' || phase === 'failed'
  if (paths.length === 0 && !terminal) return
  const files = paths.flatMap((originalPath) => {
    try {
      const path = phase === 'draft'
        ? (paths.length === 1 ? state.terminalOutcome?.artifactPath : undefined) ?? draftArtifactCopy(originalPath)
        : originalPath
      inspectProfessionalArtifact(path)
      return [{ originalPath, path }]
    } catch {
      // An unreadable or not-yet-created file is not a new open-file receipt.
      return []
    }
  })
  // 纯文字候选不能只留在内部检查点；停止后直接展示为待核验稿，不授予正式状态。
  const draftText = terminal && paths.length === 0 ? state.terminalOutcome?.candidateText : undefined
  const delivery = {
    turn: state.turn, phase, files, issues: [...state.terminalOutcome?.issues ?? []],
    ...(draftText === undefined || draftText === '' ? {} : { draftText }),
  }
  const serialized = JSON.stringify(delivery)
  if (state.lastDeliveryNotice === serialized) return
  state.lastDeliveryNotice = serialized
  const summary = phase === 'formal' ? '文件检查已通过' : phase === 'draft' ? '本轮已停止，结果待完善' : phase === 'failed' ? '本轮检查失败，已停止' : '文件检查状态已更新'
  const source = { kind: 'plugin' as const, plugin: 'gongchuang-policy-gate', form: 'notice' as const, summary, delivery }
  const text = terminal
    ? [summary, ...delivery.issues.map(issue => `- ${issue}`),
      '已保留会话和已有文件，当前结果不能作为正式交付使用。请按上述缺口补充资料或明确发起修订后继续；本轮不再自动重试。'].join('\n')
    : summary
  // 使用上游既有消息载体记录检查结果；不 steer、不重启模型，也不改写历史文件。
  agent.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }], source,
  }), { surfaceOp: 'append' })
}

/** Register the first-request provider gate and central tool-dispatch gate. */
export function apply(ctx: Context, config: Config): void {
  ctx.on('api-session/fork-preparing', preserveForkImports)
  const verified = loadVerifiedPolicy(config)
  const professional = loadProfessionalContracts(config)
  const providers = verified.manifest.providers.allow.map(wildcard)
  const allowedTools = verified.manifest.tools.allow.map(wildcard)
  const askedTools = verified.manifest.tools.ask.map(wildcard)
  const deniedTools = verified.manifest.tools.deny.map(wildcard)
  const deliveryStates = new WeakMap<Agent, ActiveDeliveryState>()
  const checkpointStore = new ProfessionalTaskCheckpointStore(config.professionalCheckpointDir)
  const producerPatterns = new Map<string, readonly RegExp[]>()
  producerPatterns.set(
    verified.manifest.delivery.professionalReceipt.id,
    verified.manifest.delivery.professionalReceipt.producerTools.map(wildcard),
  )
  for (const rule of verified.manifest.delivery.rules) {
    for (const receipt of rule.receipts) {
      producerPatterns.set(receipt.id, receipt.producerTools.map(wildcard))
    }
  }
  const receipts = new GongchuangPolicyService(
    ctx,
    producerPatterns,
    deliveryStates,
    verified.manifest.delivery.professionalReceipt.id,
    (state) => { activateFormalDelivery(state, professional, verified.manifest) },
  )
  const brandingRuntime = brandingRuntimeFromContracts(config.professionalContractsPath)

  // The model adapter boundary is the final same-process point before any
  // provider receives a request. Keep this listener global and prepended so a
  // child agent scope or compatibility plugin cannot bypass the signed
  // provider policy, even if an upstream pre-step listener is mis-scoped.
  ctx.on('llm/stream', (options, next) => {
    if (config.acceptanceFaultMode === 'pre-step') {
      throw new Error('洞见门禁验收故障：运行中策略服务不可用，已保持关闭')
    }
    if (!matches(providers, options.provider)) {
      throw new Error(`洞见门禁：模型提供方 ${options.provider} 不在签名策略允许范围内`)
    }
    return next()
  }, { global: true, prepend: true })

  // Monotonic dispatch denial is evaluated after the extensible pre-execute
  // waterfall. It cannot force-allow a call, so an untrusted plugin cannot
  // override this hard signed-policy boundary by returning allow downstream.
  ctx.tools.guard((exec) => {
    if (config.acceptanceFaultMode === 'pre-step') {
      return '洞见门禁验收故障：运行中策略服务不可用，已保持关闭'
    }
    if (exec.agent === undefined && !verified.manifest.tools.allowUnattributed) {
      return '洞见门禁：拒绝无智能体归属的工具调用'
    }
    if (matches(deniedTools, exec.name)
      || (!matches(allowedTools, exec.name) && !matches(askedTools, exec.name))) {
      return `洞见门禁：工具 ${exec.name} 不在签名策略允许范围内`
    }
    return undefined
  })

  ctx.tools.register(defineTool({
    name: 'gongchuang_render_pdf',
    description: 'Create a real PDF through the signed desktop host after a chat-mode professional preflight has accepted text identical to the static HTML source. For a PDF delivery: chat-validate the exact HTML source text, call this once, then artifact-validate the returned PDF and run every formal artifact gate. Office files remain native OOXML and are not accepted as conversion sources. The output must be a new .pdf beside the source; existing files are never overwritten.',
    parameters: {
      sourceArtifactPath: { type: 'string', required: true, description: 'Exact static HTML source whose extracted text equals the accepted chat candidate. This is an intermediate source, not the final artifact.' },
      outputPath: { type: 'string', required: true, description: 'New .pdf path in the same directory as the source. The signed host refuses overwrite.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          path: { type: 'string', required: true },
          format: { type: 'string', required: true },
          sha256: { type: 'string', required: true },
          bytes: { type: 'number', required: true },
        },
      },
      render: (_args, _value) => [{
        type: 'text',
        text: 'PDF 已生成，正在继续完成内容与版式验收。',
      }],
    },
    async execute(input, exec) {
      const workspaceRoot = professionalWorkspaceRoot(exec)
      const subject = receipts.professionalSubject(exec)
      const source = inspectProfessionalArtifact(professionalArtifactPath(exec, input.sourceArtifactPath))
      if (source.format !== 'html') throw new Error('PDF 导出源必须是静态 HTML；Office 文件保持原生 OOXML，PDF 不能再次包装')
      const neutral = inspectProfessionalBranding(source.path, brandingRuntime)
      if (neutral.artifactSha256 !== source.sha256) throw new Error('PDF 导出源在文档标识检查期间发生变化')
      const sourceContent = await resolveArtifactContent(ctx, source)
      const subjectSha256 = createHash('sha256').update(subject).digest('hex')
      if (sourceContent.sha256 !== subjectSha256) {
        throw new Error('PDF 导出源正文与 chat 模式专业预校验候选不一致；请读取实际源文件正文后重新预校验')
      }
      const renderer = ctx.get('gongchuangArtifactRenderer')
      if (renderer === undefined) throw new Error('候选安装包未绑定可信 PDF 导出器；正式 PDF 生成保持关闭')
      const receipt = parsePdfExportReceipt(await renderer.exportPdf({
        sourceArtifactPath: source.path,
        sourceArtifactSha256: source.sha256,
        sourceFormat: source.format,
        outputPath: professionalArtifactPath(exec, input.outputPath),
        workspaceRoot,
      }))
      if (receipt.sourceArtifactSha256 !== source.sha256) throw new Error('可信 PDF 导出回执与源文件身份不一致')
      const output = inspectProfessionalArtifact(receipt.outputPath)
      if (output.format !== 'pdf' || output.sha256 !== receipt.outputSha256 || output.bytes !== receipt.bytes) {
        throw new Error('可信 PDF 导出回执与实际输出文件身份不一致')
      }
      return { ok: true, path: output.path, format: output.format, sha256: output.sha256, bytes: output.bytes }
    },
    presentCall: args => ({
      card: 'generic',
      title: '生成正式 PDF',
      kind: 'edit',
      rawInput: args.outputPath,
      locations: [{ path: args.outputPath }],
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'gongchuang_professional_validate',
    description: '严格前置条件：仅当当前轮次已收到以“洞见专业执行链已锁定技能包”开头的宿主通知时才可调用；未收到该通知时禁止调用，普通咨询、续问、摘要、改写和技术说明应直接回答。Validate the exact candidate answer or Host-extracted artifact text against the active signed Skills, evidence boundaries, calculations, policy sources, high-tech four-section contract, and humanizer fact lock. Activate every required Skill named by the latest 洞见 dependency notice before constructing this call. taskType describes the business artifact, not its file shape: when standard-drafting owns the body, use standard and never report merely because the standard is delivered as DOCX. For a locked professional chat answer, provide candidateText. For PDF preflight from a static HTML source, provide candidateArtifactPath instead and let the Host extract the exact text; never copy the whole source through the model. Every numeric value derived rather than quoted verbatim from evidence must be covered by calculations, including every year, ratio, subtotal and repeated display form; do not submit only representative calculations. A successful chat preflight checkpoints its attested evidence and calculations; the following artifact validation in the same task should omit both fields and let the Host reuse that checkpoint. The result is formal, repairable, draft, or failed. Repairable permits one narrow correction using the same evidence and calculations without repeating successful reads or searches; when the issues only concern evidence or calculation binding, keep the candidate file unchanged and repair the evidence/calculations arguments. Draft and failed are terminal for the current turn and must not be resubmitted automatically. Only a chat-only delivery ends by reproducing the validated candidate exactly. File preflight must continue with generation and artifact-mode validation; artifact success must continue with the remaining file delivery checks before final delivery.',
    parameters: {
      taskType: { type: 'string', required: true, description: 'Stable business artifact category, such as policy, scoring, enterprise-profile, peer, application, standard, report, or humanizer. Use standard whenever standard-drafting owns the candidate; a DOCX delivery does not turn a standard into report.' },
      deliveryMode: { type: 'string', required: true, enum: ['chat', 'artifact'], description: 'chat locks the final answer exactly; artifact delegates file identity and rendering to the formal artifact gates.' },
      candidateText: { type: 'string', description: 'The exact final answer for a current-turn locked professional chat task. Never use this tool for a general chat. Omit when candidateArtifactPath supplies the Host-extracted static HTML source for PDF preflight. Artifact mode ignores this model value and extracts the real final file.' },
      candidateArtifactPath: { type: 'string', description: 'Chat-mode PDF preflight only. Exact path to the real static HTML source whose text the Host must extract and validate without model-side copying. PDF and Office files are rejected here because the final PDF must use artifact mode and Office remains native OOXML.' },
      artifactPath: { type: 'string', description: 'Required for artifact mode; the file path subsequently passed to the artifact gates.' },
      artifactFormat: { type: 'string', description: 'Lowercase file format declared by the selected signed delivery profile, such as docx, pdf, xlsx, or html.' },
      deliveryProfileId: { type: 'string', description: 'Use only the exact signed ID listed for the active main Skill in the latest Host notice. If that notice says the Skill owns no delivery profile, omit this field. Never invent, borrow, translate, or change an ID during a repair step.' },
      sourceText: { type: 'string', description: 'Required for humanizer work; the unmodified source used to lock facts, numbers, names, policy titles, and IP identifiers.' },
      sourceToolCallId: { type: 'string', description: 'Recommended instead of sourceText for a long customer document. Copy the exact Host-injected toolCallId from one successful read/read_image receipt; the Host uses that receipt text directly, so the model cannot alter whitespace or facts while copying it.' },
      evidence: {
        type: 'array',
        description: 'Required for chat validation and for artifact validation without a successful chat preflight. Omit it in the artifact call immediately following a successful chat preflight so the Host reuses the attested checkpoint. Every supplied evidence object MUST explicitly include status. Evidence ledger rows used by this candidate. Facts written directly in the user message use status user-provided and verbatim values from that message. Facts read from a customer file also use status user-provided, with verbatim values from the read/read_image output, a signed customer-file extraction operation, or PaddleOCR MCP; the Host binds a unique matching local-read receipt automatically, and toolCallId is required only when multiple reads contain the same values. A signed Skill reference is NOT a customer file. When its trusted read contains a gov.cn source URL and policy text used by the candidate, submit that policy row as kind official-policy, status verified, sourceUrl from the receipt, and verbatim values from the same receipt; never label it user-provided merely because read returned it. A signed deterministic calculation or run-preflight operation uses one calculated row whose source is the exact operation ID and whose values are omitted or []; the Host binds its receipt and numeric display variants automatically, so never scan the finished artifact or enumerate its numbers manually. For verified rows, prefer automatic binding with the exact sourceUrl and verbatim values. Never paraphrase evidence values. The Host replaces asOf with the receipt accessedAt and appends source numeric tokens plus that timestamp to values for numeric evidence binding. A verified government notice or official government reprint supporting a policy conclusion must use kind official-policy. Pending and conflicting rows are allowed only when disclosed in the candidate.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            kind: {
              type: 'string',
              required: true,
              description: 'Evidence category. For peer-benchmarking, use official-list for a government-published list, government-source or official-policy for a gov.cn source, and enterprise-official for an HTTPS official company source.',
            },
            status: {
              type: 'string',
              required: true,
              enum: ['verified', 'user-provided', 'calculated', 'pending', 'conflict'],
              description: 'Required on every row: use user-provided only for direct user/customer-file facts, calculated for signed deterministic calculation or run-preflight output, verified for trusted external verification and signed Skill references that preserve the official source URL, pending for unresolved gaps, or conflict for contradictory evidence. A signed Skill reference is not a customer file.',
            },
            source: { type: 'string', required: true },
            toolCallId: { type: 'string', description: 'Optional Host receipt disambiguator. Omit it when verified evidence uniquely matches exact sourceUrl plus values, or when customer-file evidence uniquely matches verbatim values from one read/read_image, signed gongchuang_skill_operation, or PaddleOCR MCP result. If duplicate outputs are ambiguous, copy the exact ID from the Host-injected 洞见证据回执 context. Never type it from memory.' },
            sourceUrl: { type: 'string' },
            sha256: { type: 'string' },
            asOf: { type: 'string', description: 'Optional model hint. When a trusted receipt is bound, the Host replaces this with the real receipt accessedAt timestamp.' },
            values: { type: 'array', description: 'Every non-pending entry must be an exact verbatim substring of its bound source: the direct user message, a customer-file read/read_image, signed gongchuang_skill_operation or PaddleOCR MCP output, or a verified trusted-tool output. Prefer the shortest exact fragment supporting the fact; preserve punctuation, without line-number prefixes or whole-line copying. source is a display label, not a read identity; renaming it cannot repair mismatched values. Put interpretation in candidateText, not here. Pending rows may describe the unresolved gap.', items: { type: 'string' } },
          },
        },
      },
      calculations: {
        type: 'array',
        description: 'Deterministic calculations. Omit in the artifact call after a successful chat preflight to reuse the same checkpoint. Otherwise cover every candidate number that is derived rather than quoted verbatim from evidence: every year, ratio, subtotal, cross-year change and repeated display form, not only representative indicators. Scoring tasks require at least one row and every row must bind evidence IDs. Operator semantics are exact: sum adds all inputs; subtract evaluates first minus the rest; multiply multiplies all inputs; divide evaluates inputs[0]/inputs[1]; ratio also divides two inputs but result is the displayed percentage number, so 2350/2900 must use operator ratio with result 81.03 and binds candidate token 81.03%; weighted-sum requires one weight per input. Do not encode a percentage as multiply(0.8103,100) or multiply(0.8103,1).',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            operator: { type: 'string', required: true, enum: ['sum', 'subtract', 'multiply', 'divide', 'ratio', 'weighted-sum'] },
            inputs: { type: 'array', required: true, items: { type: 'number' } },
            weights: { type: 'array', items: { type: 'number' } },
            result: { type: 'number', required: true },
            evidenceIds: { type: 'array', required: true, description: 'IDs from the evidence array only, never calculation IDs. A calculation using earlier results must retain those results\' original source evidence IDs. For example, if c1 uses E1 and c2 uses E2, c3 = c1 - c2 binds [E1, E2], not [c1, c2].', items: { type: 'string' } },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          status: { type: 'string', required: true, enum: ['formal', 'repairable', 'draft', 'failed'] },
          nextStep: { type: 'string', required: true, description: 'Required next action for this delivery mode. formal validates the candidate, not the complete file delivery.' },
          taskType: { type: 'string', required: true },
          deliveryMode: { type: 'string', required: true, enum: ['chat', 'artifact'] },
          candidateSha256: { type: 'string', required: true },
          evidenceIds: { type: 'array', required: true, items: { type: 'string' } },
          checks: { type: 'array', required: true, items: { type: 'string' } },
          criticalIssues: { type: 'array', required: true, items: { type: 'string' } },
          advisoryIssues: { type: 'array', required: true, items: { type: 'string' } },
          artifactPath: {
            type: 'string',
            required: true,
            description: 'Resolved validated artifact path, or an empty string when this chat-mode result has no artifact. The field is always present so run_code projections remain lossless JSON.',
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          value.nextStep,
          value.criticalIssues.length === 0 ? '' : `\n未通过项：\n${value.criticalIssues.map(issue => `- ${issue}`).join('\n')}`,
          value.advisoryIssues.length === 0 ? '' : `\n建议项：\n${value.advisoryIssues.map(issue => `- ${issue}`).join('\n')}`,
        ].filter(Boolean).join('\n'),
      }],
    },
    async execute(input, exec) {
      const state = exec.agent === undefined ? undefined : deliveryStates.get(exec.agent)
      if (state === undefined) throw new Error('gongchuang-policy-gate: no active professional turn')
      const checkpoint = input.deliveryMode === 'artifact' ? state.professionalLedger : undefined
      const suppliedEvidence = input.evidence ?? checkpoint?.evidence
      const suppliedCalculations = input.calculations ?? checkpoint?.calculations ?? []
      let rejectedCandidateText = normalizeProfessionalCandidate(input.candidateText ?? '')
      // HTML preflight is chat-mode by design, but it still owns a real
      // candidate file. Retain that path so a failed bounded repair can read
      // exactly this file and the Host can preserve it as a marked draft.
      let rejectedArtifactPath = input.artifactPath ?? input.candidateArtifactPath
      let attestedLedgerForArtifact: ProfessionalLedger | undefined
      const candidateArtifactPath = typeof input.candidateArtifactPath === 'string'
        && input.candidateArtifactPath.trim().length > 0
        ? input.candidateArtifactPath
        : undefined
      if (state.terminalOutcome !== undefined) {
        const terminal = state.terminalOutcome
        return {
          ok: false,
          status: terminal.status === 'draft' ? 'draft' as const : 'failed' as const,
          nextStep: terminal.status === 'draft'
            ? `本轮已有限收束为待完善稿，不再自动重复校验。${terminal.artifactPath === undefined ? '' : `请仅对返回路径执行打开、正文、品牌及适用的视觉检查，不得再次提交专业校验或描述为正式通过：${terminal.artifactPath}`}`
            : '本轮因基础能力故障停止，已保留会话与已有文件，不再自动重试。',
          taskType: input.taskType,
          deliveryMode: input.deliveryMode,
          candidateSha256: createHash('sha256').update(terminal.candidateText ?? rejectedCandidateText).digest('hex'),
          evidenceIds: [...new Set((suppliedEvidence ?? []).map(item => item.id).filter(Boolean))].sort(),
          checks: [],
          criticalIssues: [...terminal.issues],
          advisoryIssues: [],
          artifactPath: terminal.artifactPath ?? '',
        }
      }
      try {
        const requiredSkills = receipts.requiredProfessionalSkills(exec)
        if (requiredSkills.length === 0) throw new Error('洞见专业校验只能用于已锁定专业 Skill 的当前轮次')
        const missingActivatedSkills = requiredSkills
          .filter(skill => !state.activatedSkills.has(skill))
          .sort()
        if (missingActivatedSkills.length > 0) {
          // 必需依赖若拖到交付后的 turn-stopping 才发现，模型会先生成文件，
          // 再补激活技能，最终又因回复文本与 chat 候选不同而被判为待完善。
          // 在首次专业预校验前返回可修复诊断，让依赖只补一次且不消耗正文修订预算。
          const candidateText = normalizeProfessionalCandidate(input.candidateText ?? '')
          return {
            ok: false,
            status: 'repairable' as const,
            nextStep: '先逐项激活缺失的必需技能，再原样提交本次候选进行专业校验；无需重读资料或重写候选正文。',
            taskType: input.taskType,
            deliveryMode: input.deliveryMode,
            candidateSha256: createHash('sha256').update(candidateText).digest('hex'),
            evidenceIds: [...new Set((suppliedEvidence ?? []).map(item => item.id).filter(Boolean))].sort(),
            checks: [],
            criticalIssues: [
              `专业校验前尚未激活 V${professional.ruleVersion} 必需技能：`,
              ...missingActivatedSkills.map(skill => `- ${skill}`),
            ],
            advisoryIssues: [],
            artifactPath: '',
          }
        }
        const contractSkills = receipts.professionalContractSkills(exec)
        if (contractSkills.length === 0) throw new Error('洞见专业校验前必须先激活负责本任务正文结构的专业 Skill')
        if (suppliedEvidence === undefined) {
          throw new Error(input.deliveryMode === 'chat'
            ? 'chat 专业校验必须提供 evidence'
            : 'artifact 专业校验缺少 evidence，且当前任务没有可复用的成功 chat 预校验检查点')
        }
        if (input.sourceText !== undefined && input.sourceToolCallId !== undefined) {
          throw new Error('sourceText 与 sourceToolCallId 只能选择一种原文绑定方式')
        }
        const hasCandidateText = typeof input.candidateText === 'string' && input.candidateText.trim().length > 0
        const hasCandidateArtifactPath = candidateArtifactPath !== undefined
        if (input.deliveryMode === 'chat' && hasCandidateText === hasCandidateArtifactPath) {
          throw new Error('chat 模式必须且只能选择 candidateText 或 candidateArtifactPath 其中一种候选正文来源')
        }
        if (input.deliveryMode === 'artifact' && input.candidateArtifactPath !== undefined) {
          throw new Error('candidateArtifactPath 仅用于静态 HTML 转 PDF 前的 chat 模式预校验')
        }
        const sourceText = input.sourceToolCallId === undefined
          ? input.sourceText
          : receipts.sourceTextFromLocalRead(exec, input.sourceToolCallId)
        let attestedEvidence: readonly ProfessionalEvidence[] = suppliedEvidence
        let attestationError: string | undefined
        try {
          attestedEvidence = receipts.attestEvidence(exec, suppliedEvidence, sourceText)
          attestedLedgerForArtifact = professionalLedger(attestedEvidence, suppliedCalculations)
        } catch (error: unknown) {
          // 未绑定数据只用于一次性列全结构和复算问题；有来源错误时绝不能生成通过回执。
          attestationError = error instanceof Error ? error.message : String(error)
        }
        let artifact: ProfessionalArtifactInspection | undefined
        let artifactContent: { text: string; sha256: string } | undefined
        let candidateArtifactContent: { text: string; sha256: string } | undefined
        if (input.deliveryMode === 'chat' && hasCandidateArtifactPath) {
          const candidateArtifact = inspectProfessionalArtifact(professionalArtifactPath(exec, candidateArtifactPath))
          if (candidateArtifact.format !== 'html') {
            throw new Error('chat 模式 candidateArtifactPath 只接受静态 HTML；PDF 必须使用 artifact 模式，Office 保持原生 OOXML')
          }
          candidateArtifactContent = await resolveArtifactContent(ctx, candidateArtifact)
        }
        const {
          sourceToolCallId: _sourceToolCallId,
          sourceText: _modelSourceText,
          candidateArtifactPath: _candidateArtifactPath,
          evidence: _modelEvidence,
          calculations: _modelCalculations,
          ...professionalInput
        } = input
        let candidate = {
          ...professionalInput,
          candidateText: candidateArtifactContent?.text ?? input.candidateText ?? '',
          ...(sourceText === undefined ? {} : { sourceText }),
          evidence: [...attestedEvidence],
          calculations: [...suppliedCalculations],
        }
        if (input.deliveryMode === 'artifact') {
          if (input.artifactPath === undefined) throw new Error('正式文件缺少 artifactPath')
          artifact = inspectProfessionalArtifact(professionalArtifactPath(exec, input.artifactPath))
          artifactContent = await resolveArtifactContent(ctx, artifact, professionalWorkspaceRoot(exec))
          if (input.artifactFormat !== undefined && input.artifactFormat.toLowerCase() !== artifact.format) {
            throw new Error(`声明格式 ${input.artifactFormat} 与实际文件格式 ${artifact.format} 不一致`)
          }
          candidate = {
            ...candidate,
            artifactPath: artifact.path,
            artifactFormat: artifact.format,
            candidateText: artifactContent.text,
          }
        }
        rejectedCandidateText = normalizeProfessionalCandidate(candidate.candidateText)
        rejectedArtifactPath = artifact?.path ?? rejectedArtifactPath
        let result
        try {
          result = validateProfessionalCandidate(
            professional,
            requiredSkills,
            candidate,
            contractSkills,
            receipts.professionalResponseDepth(exec),
            state.userEvidenceText,
          )
          if (attestationError !== undefined) throw new Error(attestationError)
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error)
          const issues = [...new Set([attestationError, message].filter((issue): issue is string => issue !== undefined))]
          throw new Error(
            `${issues.join('\n')}\n洞见最小充分修复：保留本次 candidateText、evidence 与 calculations，`
          + '只修改上方逐项列出的缺口后再次校验；不得重新调用已经成功的读取、检索或技能。',
            { cause: error },
          )
        }
        receipts.claim(
          exec,
          verified.manifest.delivery.professionalReceipt.id,
          input.deliveryMode === 'chat' ? candidate.candidateText : undefined,
          artifact === undefined || artifactContent === undefined
            ? undefined
            : {
              path: artifact.path,
              format: artifact.format,
              sha256: artifact.sha256,
              candidateSha256: result.candidateSha256,
              contentSha256: artifactContent.sha256,
              ...(input.deliveryProfileId === undefined ? {} : { deliveryProfileId: input.deliveryProfileId }),
            },
          professionalLedger(attestedEvidence, suppliedCalculations),
        )
        // PTC 只返回结构化值，不转发 render 文案。两种通道必须共用下一步，
        // 专业正文通过不等于文件交付完成，不能在文件检查前指示模型结束。
        const nextStep = input.deliveryMode === 'artifact'
          ? '专业规则检查已完成。请对同一最终文件继续完成 gongchuang_artifact_probe、gongchuang_content_audit、gongchuang_branding_gate；PDF 还需 gongchuang_visual_inspection。首次 artifact 校验前不得执行可打开性探测；同一已绑定且未修改文件的有效检查无需重复。全部交付检查通过后再返回文件，本次结果不代表文件已正式交付。'
          : candidateArtifactPath !== undefined
            ? '文件正文预校验已完成。请调用 gongchuang_render_pdf 从本次 HTML 源文件生成 PDF，再用 artifact 模式校验实际 PDF，并完成可打开性、正文一致性、文档标识与逐页视觉检查。当前尚未完成文件交付，不得直接结束或发布 HTML 中间源。'
            : input.deliveryProfileId !== undefined || input.artifactFormat !== undefined
              ? '文件正文预校验已完成。请在当前 run_code 内立即用同一 candidateText 变量生成所选格式的文件；宿主会注入已验收正文，不得重新拼写。再用 artifact 模式校验真实文件，并完成对应交付检查。当前尚未完成文件交付，不得直接输出候选正文结束本轮。'
              : '专业规则检查已完成。下一条最终消息只能逐字输出本次候选正文，不得添加任何前后缀或改动格式。'
        return {
          ...result,
          status: 'formal' as const,
          nextStep,
          criticalIssues: [],
          advisoryIssues: result.advisoryIssues,
          artifactPath: artifact?.path ?? '',
        }
      } catch (error: unknown) {
        let status: 'repairable' | 'draft' | 'failed' = professionalFailureStatus(error)
        const issues = professionalFailureIssues(error)
        let artifactPath: string | undefined
        // 用户已明确接受“政策不可核验时交付待完善稿”时，不再把这个
        // 外部证据缺口发回给模型空转。只允许“唯一缺口是政策原文”且成品
        // 已显式标注草稿；结构、计算或其他证据错误仍保留一次有界修正。
        const terminalPolicyDraft = status === 'draft'
          && explicitlyAllowsTerminalPolicyDraft(state.userEvidenceText, rejectedCandidateText, issues)
        // 聊天预校验只检查成稿前的候选正文。如果唯一缺口是用户已知的官方政策
        // 原文，此时终止会让模型永远无法生成用户要的待完善文件。因此只允许它继续
        // 生成本次文件；后续 artifact 校验仍会标记待完善并有限收束。
        const continueDraftToArtifact = status === 'draft'
          && input.deliveryMode === 'chat'
          && (candidateArtifactPath !== undefined
            || input.deliveryProfileId !== undefined
            || input.artifactFormat !== undefined
            // 文件交付意图由签名策略在首个请求中锁定，不能再依赖模型是否
            // 重复填写可选的 artifactFormat。否则用户已明确要求 DOCX，模型
            // 漏传一个提示性字段时，待完善候选会在真正生成文件前被终止。
            || state.required.has('artifact-openability'))
        if (status === 'draft' && !terminalPolicyDraft && state.professionalValidationFailures === 0) {
          status = 'repairable'
          state.professionalValidationFailures = 1
          state.correctionCount = 1
        }
        if (status === 'draft' && continueDraftToArtifact && attestedLedgerForArtifact !== undefined) {
          // 草稿正文未达正式合同，不等于证据绑定失败。仅保存已验真的台账供
          // 紧接着的 artifact 校验复用；这里不产生专业通过回执，也不会在
          // 当前工具结果失败或被下游拒绝时提交状态。
          receipts.checkpointProfessionalLedger(exec, attestedLedgerForArtifact)
        }
        if (status === 'repairable') {
          state.professionalRepairPending = true
          state.professionalRepairStepIssued = false
          state.professionalRepairWriteRetryUsed = false
          delete state.professionalRepairWriteRetryPath
          state.professionalRepairIssues = Object.freeze([...new Set(issues)])
          state.professionalRepairCandidateText = rejectedCandidateText
          // 聊天交付没有文件路径。无值时删除旧字段，既满足严格可选属性，
          // 也避免恢复后的修复状态误用上一份文件。
          if (rejectedArtifactPath === undefined) delete state.professionalRepairArtifactPath
          else state.professionalRepairArtifactPath = rejectedArtifactPath
        } else {
          state.professionalRepairPending = false
          state.professionalRepairStepIssued = false
          state.professionalRepairWriteRetryUsed = false
          delete state.professionalRepairWriteRetryPath
          state.professionalRepairIssues = []
          delete state.professionalRepairCandidateText
          delete state.professionalRepairArtifactPath
        }
        if (status === 'draft' && input.deliveryMode === 'artifact' && rejectedArtifactPath !== undefined) {
          try {
            artifactPath = draftArtifactCopy(rejectedArtifactPath)
          } catch (copyError: unknown) {
            status = 'failed'
            issues.push(...professionalFailureIssues(copyError))
          }
        }
        // 文件预校验失败表示“不能授予正式状态”，不表示“禁止生成文件”。
        // 唯一修正用完后仍允许把同一候选生成一次待完善文件；随后 artifact
        // 校验会绑定真实文件、复制为带“待完善”的安全文件名并有限结束。
        // 若在这里直接写 terminalOutcome，下一模型步会被拒绝，用户只能看到
        // 对话正文而拿不到已经要求的 DOCX，这正是历史上反复卡住交付的根因。
        if (status !== 'repairable' && !continueDraftToArtifact) {
          state.terminalOutcome = Object.freeze({
            status,
            issues: Object.freeze([...new Set(issues)]),
            ...(rejectedCandidateText === '' ? {} : { candidateText: rejectedCandidateText }),
            ...(artifactPath === undefined ? {} : { artifactPath }),
            ...(input.deliveryMode !== 'artifact' || input.artifactPath === undefined ? {} : { originalArtifactPath: input.artifactPath }),
          })
        }
        // 普通合同缺口是交付分级，不是运行时异常。结构化结果只是诊断；
        // 真正停止由下一次 pre-step 拒绝执行，不能依赖模型自行遵守返回文案。
        return {
          ok: false,
          status,
          nextStep: status === 'repairable'
            ? '专业规则检查发现确定性缺口。本轮只允许按诊断修正一次；可仅重读本次被拒候选文件，不得读取其他资料或重新检索，修正后再校验一次。'
            : status === 'draft'
              ? continueDraftToArtifact
                ? '候选正文未达到正式合同，且本轮修正预算已经用完。不要再次提交 chat 校验；请在下一个且仅一个 run_code 中，用同一候选正文生成本次指定格式的文件、完成适用的品牌处理，再以 artifact 模式校验真实文件。若 artifact 校验返回 draft，立即对返回的 artifactPath 完成可打开性、正文、品牌及适用的视觉检查；不得重新读取、检索或扩大修补。宿主会把未通过项和文件一并标为待完善并有限结束。'
                : `本轮已有限收束为待完善稿，不再自动重复校验。${artifactPath === undefined ? '' : `请仅对返回路径执行打开、正文、品牌及适用的视觉检查，不得再次提交专业校验或描述为正式通过：${artifactPath}`}`
              : '本轮因基础能力故障停止，已保留会话与已有文件，不再自动重试。',
          taskType: input.taskType,
          deliveryMode: input.deliveryMode,
          candidateSha256: createHash('sha256').update(rejectedCandidateText).digest('hex'),
          evidenceIds: [...new Set((suppliedEvidence ?? []).map(item => item.id).filter(Boolean))].sort(),
          checks: [],
          criticalIssues: [...new Set(issues)],
          advisoryIssues: [],
          artifactPath: artifactPath ?? '',
        }
      }
    },
    presentCall: args => ({ card: 'generic', title: `专业校验 · ${args.taskType}`, kind: 'read', rawInput: args.taskType }),
  }))

  ctx.tools.register(defineTool({
    name: 'gongchuang_artifact_probe',
    description: 'Open and structurally inspect a completed Office, HTML, or PDF file, then publish it to the chat as an openable deliverable. A professional file must be either formally bound by the current professional kernel or the exact Host-created terminal draft path returned after bounded validation. A draft remains marked pending and never becomes formal. For ordinary document creation this tool verifies and publishes the real file directly. Call once for each delivered file, never for build scripts or temporary images.',
    parameters: {
      artifactPath: { type: 'string', required: true, description: 'Exact formal artifact path or Host-returned terminal draft path.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          path: { type: 'string', required: true },
          format: { type: 'string', required: true },
          sha256: { type: 'string', required: true },
          bytes: { type: 'number', required: true },
          units: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `交付物可打开性通过：${value.format} · ${String(value.units)} 个内容单元` }],
    },
    execute(input, exec) {
      const binding = receipts.artifactBindingIfPresent(exec)
      const state = exec.agent === undefined ? undefined : deliveryStates.get(exec.agent)
      // 普通文件可以直接探测并发布；专业任务必须先让 artifact 校验把同一
      // 文件绑定到已核验正文。否则一次中间探测就会在聊天中暴露未品牌化、
      // 未完成结构检查的文件卡片，用户容易把失败产物误当成最终交付。
      const target = professionalArtifactGateTarget(state, binding, exec, input.artifactPath)
      if (state !== undefined && state.professionalSkills.size > 0 && target === undefined) {
        throw new Error('专业文件尚未完成 artifact 专业校验；请先对同一最终文件调用 gongchuang_professional_validate，再执行可打开性探测。')
      }
      const inspection = target?.inspection
        ?? inspectProfessionalArtifact(professionalArtifactPath(exec, input.artifactPath))
      if (target?.status === 'formal') receipts.claim(exec, 'artifact-openability')
      return Promise.resolve({
        ok: true,
        path: inspection.path,
        format: inspection.format,
        sha256: inspection.sha256,
        bytes: inspection.bytes,
        units: inspection.units,
      })
    },
    presentCall: args => ({
      card: 'generic',
      title: '验收并发布交付文件',
      kind: 'read',
      locations: [{ path: args.artifactPath }],
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'gongchuang_content_audit',
    description: 'Re-extract the actual artifact text and prove it is byte-identical at the normalized content hash to either the formally bound candidate or the exact Host-created terminal draft candidate. Draft inspection never grants a formal receipt.',
    parameters: {
      artifactPath: { type: 'string', required: true, description: 'Exact formal artifact path or Host-returned terminal draft path.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          artifactSha256: { type: 'string', required: true },
          contentSha256: { type: 'string', required: true },
          characters: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `交付物正文一致性通过：${String(value.characters)} 字符` }],
    },
    async execute(input, exec) {
      const binding = receipts.artifactBindingIfPresent(exec)
      const state = exec.agent === undefined ? undefined : deliveryStates.get(exec.agent)
      const target = professionalArtifactGateTarget(state, binding, exec, input.artifactPath)
      if (target === undefined) throw new Error('洞见交付物尚未通过专业正文校验，也没有可检查的待完善终态副本')
      const { inspection } = target
      const content = await resolveArtifactContent(ctx, inspection, professionalWorkspaceRoot(exec))
      const expectedSha256 = target.status === 'formal'
        ? target.binding?.contentSha256
        : target.candidateText === undefined
          ? undefined
          : createHash('sha256').update(normalizeProfessionalCandidate(target.candidateText)).digest('hex')
      if (expectedSha256 === undefined || content.sha256 !== expectedSha256
        || (target.status === 'formal' && target.binding?.contentSha256 !== target.binding?.candidateSha256)) {
        throw new Error('交付物实际正文与已通过专业画像校验的正文不一致')
      }
      if (target.status === 'formal') receipts.claim(exec, 'content-audit')
      return {
        ok: true,
        artifactSha256: inspection.sha256,
        contentSha256: content.sha256,
        characters: content.text.length,
      }
    },
    presentCall: () => ({ card: 'generic', title: '正文与事实门禁', kind: 'read' }),
  }))

  ctx.tools.register(defineTool({
    name: 'gongchuang_branding_gate',
    description: 'Verify that a bound or exact Host-created terminal draft does not contain inherited publisher branding or watermark assets. PDF text is extracted by the trusted renderer; PDF source and page layout are checked separately. Draft inspection never grants a formal receipt.',
    parameters: {
      artifactPath: { type: 'string', required: true, description: 'Exact formal artifact path or Host-returned terminal draft path.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          format: { type: 'string', required: true },
          artifactSha256: { type: 'string', required: true },
          brandIdentity: { type: 'string', required: true },
          watermarkCount: { type: 'number', required: true },
          checks: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, _value) => [{ type: 'text', text: '文档标识检查通过。' }],
    },
    async execute(input, exec) {
      const binding = receipts.artifactBindingIfPresent(exec)
      const state = exec.agent === undefined ? undefined : deliveryStates.get(exec.agent)
      const target = professionalArtifactGateTarget(state, binding, exec, input.artifactPath)
      if (target === undefined) throw new Error('洞见交付物尚未通过专业正文校验，也没有可检查的待完善终态副本')
      const { inspection } = target
      if (inspection.format === 'pdf') {
        const content = await resolveArtifactContent(ctx, inspection, professionalWorkspaceRoot(exec))
        const identity = professionalBrandIdentity(brandingRuntime)
        if (content.text.includes(identity)) throw new Error('PDF 仍包含旧产品品牌身份，请检查源文件页眉和水印')
        if (target.status === 'formal') receipts.claim(exec, 'brand-watermark')
        return {
          ok: true,
          format: inspection.format,
          artifactSha256: inspection.sha256,
          brandIdentity: '',
          watermarkCount: 0,
          checks: ['no-legacy-pdf-identity-text', 'automatic-page-regression-separate'],
        }
      }
      const result = inspectProfessionalBranding(inspection.path, brandingRuntime)
      if (result.artifactSha256 !== inspection.sha256) throw new Error('品牌验收对象发生漂移')
      if (target.status === 'formal') receipts.claim(exec, 'brand-watermark')
      return { ...result, checks: [...result.checks] }
    },
    presentCall: () => ({ card: 'generic', title: '文档标识检查', kind: 'read' }),
  }))

  ctx.tools.register(defineTool({
    name: 'gongchuang_visual_inspection',
    description: 'Run signed-host automatic visual regression over every page of an exact formally bound or Host-created terminal draft PDF. Office artifacts use structural, content, branding, and openability checks instead. A terminal draft remains pending and never grants a formal receipt. Missing references, excess differences, or an untrusted renderer fail closed.',
    parameters: {
      artifactPath: { type: 'string', required: true, description: 'Exact formal PDF path or Host-returned terminal draft PDF path.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          rendererId: { type: 'string', required: true },
          status: { type: 'string', required: true },
          review: { type: 'string', required: true },
          artifactSha256: { type: 'string', required: true },
          comparison: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              reference: { type: 'string', required: true },
              maxChangedPixelRatio: { type: 'number', required: true },
              maxMeanAbsoluteError: { type: 'number', required: true },
              changedPixelRatioTolerance: { type: 'number', required: true },
              meanAbsoluteErrorTolerance: { type: 'number', required: true },
            },
          },
          pages: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                page: { type: 'number', required: true },
                width: { type: 'number', required: true },
                height: { type: 'number', required: true },
                pngSha256: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `PDF 自动视觉回归通过：${String(value.pages.length)} 页` }],
    },
    async execute(input, exec) {
      const binding = receipts.artifactBindingIfPresent(exec)
      const state = exec.agent === undefined ? undefined : deliveryStates.get(exec.agent)
      const target = professionalArtifactGateTarget(state, binding, exec, input.artifactPath)
      if (target === undefined) throw new Error('洞见交付物尚未通过专业正文校验，也没有可检查的待完善终态副本')
      const { inspection } = target
      if (inspection.format !== 'pdf') throw new Error('自动视觉回归只接受最终 PDF；Office 产物不执行转 PDF 图像比较')
      const renderer = ctx.get('gongchuangArtifactRenderer')
      if (renderer === undefined) throw new Error('候选安装包未绑定可信跨平台逐页渲染器；视觉回执保持关闭')
      const result = parseRenderReceipt(await renderer.renderAndReview({
        artifactPath: inspection.path,
        artifactSha256: inspection.sha256,
        format: inspection.format,
        workspaceRoot: professionalWorkspaceRoot(exec),
      }))
      if (result.artifactSha256 !== inspection.sha256 || result.pages.length === 0) {
        throw new Error('可信逐页渲染回执身份、状态或交付物哈希不一致')
      }
      const pageNumbers = new Set<number>()
      for (const page of result.pages) {
        if (!Number.isSafeInteger(page.page) || page.page <= 0 || pageNumbers.has(page.page)
          || !Number.isSafeInteger(page.width) || !Number.isSafeInteger(page.height)
          || page.width < 400 || page.height < 400 || !/^[0-9a-f]{64}$/u.test(page.pngSha256)) {
          throw new Error('可信逐页渲染回执包含无效、重复或过小页面')
        }
        pageNumbers.add(page.page)
      }
      for (let page = 1; page <= result.pages.length; page += 1) {
        if (!pageNumbers.has(page)) throw new Error('可信逐页渲染回执页码不连续')
      }
      if (result.pages.length !== inspection.units) {
        throw new Error('PDF 实际页数与逐页渲染回执不一致')
      }
      if (target.status === 'formal') receipts.claim(exec, 'visual-inspection')
      return { ok: true, ...result }
    },
    presentCall: args => ({
      card: 'generic',
      title: '逐页渲染视觉验收',
      kind: 'read',
      rawInput: args.artifactPath,
      locations: [{ path: args.artifactPath }],
    }),
  }))

  ctx.logger.info(
    `gongchuang policy active: verified runtime-fault=${config.acceptanceFaultMode ?? 'none'}`,
  )

  // Awaited waterfall: this runs before request derivation, including the first
  // request. A provider not covered by the signed policy never reaches a model.
  ctx.on('agent/pre-step', async ({ agent, messages, turn, step, signal }, next): Promise<PreStepDecision> => {
    if (config.acceptanceFaultMode === 'pre-step') {
      throw new Error('洞见门禁验收故障：运行中策略服务不可用，已保持关闭')
    }
    if (signal.aborted) return Promise.resolve({ kind: 'reject' })
    const provider = agent.options.provider
    if (provider === undefined || !matches(providers, provider)) {
      ctx.logger.warn(`gongchuang policy rejected provider: ${provider ?? '<unset>'}`)
      return Promise.resolve({ kind: 'reject' })
    }
    // The request array contains the whole conversation.  Routing on every
    // historical user message made one earlier professional task contaminate
    // every later ordinary question in the same chat.  Only the latest real
    // user message describes the current turn; plugin notices have their own
    // source kind and are deliberately excluded.
    const currentUserMessage = [...messages].reverse()
      .find(message => message.source.kind === 'user')
    const displayText = currentUserMessage !== undefined && 'displayText' in currentUserMessage.source
      && typeof currentUserMessage.source.displayText === 'string' ? currentUserMessage.source.displayText : undefined
    const userText = userIntentText(currentUserMessage?.content
      .map(block => block.type === 'text' ? block.text : '')
      .join('\n') ?? '', displayText)
    const prior = deliveryStates.get(agent)
    let resumeContext: ReturnType<typeof createUserMessage> | undefined
    let preserveStoredCheckpoint = false
    let state: ActiveDeliveryState
    if (prior !== undefined && prior.turn === turn) {
      state = prior
      if (state.terminalOutcome?.status === 'draft' || state.terminalOutcome?.status === 'failed') {
        // 工具结果已落盘后才展示终态；拒绝下一步，避免模型忽略 draft 后换工具继续修复。
        state.phase = state.terminalOutcome.status
        await persistDeliveryState(checkpointStore, agent, state)
        return { kind: 'reject' }
      }
    } else {
      state = createDeliveryState(
        turn,
        agent.session.seq,
        professional.ruleVersion,
        verified.manifest.executionBudgets.search.defaultTier,
      )
      const explicitContinuation = explicitlyContinuesProfessionalTask(userText)
      const mayAnswerPanoramaChoice = hasEnterprisePanoramaMode(userText)
      if (explicitContinuation || mayAnswerPanoramaChoice) {
        const stored = await checkpointStore.read(String(agent.session.id))
        if (stored.kind === 'corrupt' && explicitContinuation) {
          preserveStoredCheckpoint = true
          state.phase = 'waiting-user'
          state.terminalOutcome = Object.freeze({
            status: 'waiting-user',
            issues: Object.freeze([`本地任务检查点损坏：${stored.reason}`]),
          })
          resumeContext = createUserMessage({
            content: [{
              type: 'text',
              text: '本地专业任务检查点无法验证，任务已保持暂停。不得从头重跑、重复读取或把旧结果冒充已恢复；请向用户说明需要从现有文件发起一次新的修订。',
            }],
            source: { kind: 'plugin', plugin: 'gongchuang-policy-gate', form: 'notice', summary: '专业任务检查点损坏' },
          })
        } else if (stored.kind === 'found') {
          const storedPhase = stored.checkpoint.phase === 'running' ? 'paused' : stored.checkpoint.phase
          const canResumeChoice = storedPhase === 'waiting-user' && mayAnswerPanoramaChoice
          if (explicitContinuation || canResumeChoice) {
            if (stored.checkpoint.contractVersion !== professional.ruleVersion) {
              preserveStoredCheckpoint = true
              state.phase = 'waiting-user'
              state.terminalOutcome = Object.freeze({
                status: 'waiting-user',
                issues: Object.freeze([
                  `任务合同版本 V${stored.checkpoint.contractVersion} 与当前 V${professional.ruleVersion} 不一致`,
                ]),
              })
              resumeContext = createUserMessage({
                content: [{
                  type: 'text',
                  text: `该任务锁定技能合同 V${stored.checkpoint.contractVersion}，当前运行时为 V${professional.ruleVersion}。任务继续保持暂停，不得静默切换合同或重新执行；请向用户说明需恢复兼容技能版本后再继续。`,
                }],
                source: { kind: 'plugin', plugin: 'gongchuang-policy-gate', form: 'notice', summary: '专业任务合同版本不兼容' },
              })
            } else if (storedPhase !== 'formal') {
              state = restoreDeliveryState(
                stored.checkpoint.payload,
                turn,
                stored.checkpoint.taskStartSeq,
                stored.checkpoint.contractVersion,
                'running',
                verified.manifest,
                professional,
              )
              const startsUserRevision = storedPhase === 'draft' || storedPhase === 'failed'
                || state.terminalOutcome?.status === 'draft' || state.terminalOutcome?.status === 'failed'
              if (startsUserRevision) {
                delete state.terminalOutcome
                state.correctionCount = 0
                state.professionalValidationFailures = 0
                state.professionalRepairPending = false
                state.professionalRepairStepIssued = false
                state.professionalRepairWriteRetryUsed = false
                delete state.professionalRepairWriteRetryPath
                state.professionalRepairIssues = []
                delete state.professionalRepairCandidateText
                delete state.professionalRepairArtifactPath
              } else if (storedPhase === 'waiting-user') {
                delete state.terminalOutcome
              }
              state.noticeInjected = true
              resumeContext = createUserMessage({
                content: [{
                  type: 'text',
                  text: `已从本地检查点恢复同一专业任务：合同 V${state.contractVersion}，已复用 ${String(state.evidenceReceipts.size)} 项受信任证据和 ${String(state.activatedSkills.size)} 项已激活技能。不得重新读取、检索或重复申请授权；只继续尚未完成的步骤。`,
                }],
                source: { kind: 'plugin', plugin: 'gongchuang-policy-gate', form: 'notice', summary: '专业任务已从检查点恢复' },
              })
            }
          }
        }
      }
    }
    for (const skill of invokedSkillNames(messages)) activateObservedSkill(state, professional, skill)
    state.userEvidenceText = normalizeProfessionalCandidate(
      [state.userEvidenceText, userText].filter(Boolean).join('\n'),
    )
    state.searchBudgetTierId = searchBudgetForText(
      verified.manifest.executionBudgets.search,
      state.userEvidenceText,
    ).id
    if (verified.manifest.executionBudgets.search.triggerAny.some(trigger => userText.includes(trigger))) {
      state.searchBudgetActive = true
    }
    activateProfessionalRules(state, professional, userText)
    refreshEnterprisePanoramaMode(state)
    for (const rule of verified.manifest.delivery.rules) {
      if (!deliveryRuleMatches(rule, userText)) continue
      // Generic Word/PDF creation is a normal client capability.  The strict
      // professional delivery chain only applies after the current task has
      // actually matched a business skill; a bare file-format request must not
      // be promoted into a policy/application workflow.
      if (rule.id === 'formal-artifact' && state.professionalSkills.size === 0) {
        state.genericArtifactRequested = true
        continue
      }
      activateDeliveryRule(state, rule)
      if (rule.id === 'formal-artifact') activateFormalDelivery(state, professional, verified.manifest)
    }
    if (state.professionalSkills.size > 0) {
      state.required.set(verified.manifest.delivery.professionalReceipt.id, verified.manifest.delivery.professionalReceipt)
    }
    deliveryStates.set(agent, state)
    let injectProfessionalRepairNotice = false
    let injectProfessionalWriteRetryNotice = false
    if (state.professionalRepairPending) {
      if (state.professionalRepairStepIssued) {
        // `repairable` grants exactly one further model step.  If that step did
        // not settle a repaired professional validation, the Host closes the
        // turn itself; otherwise the model can keep browsing and never reach
        // the second validation that used to enforce the limit.
        closeExpiredProfessionalRepair(state)
        await persistDeliveryState(checkpointStore, agent, state)
        return { kind: 'reject' }
      }
      state.professionalRepairStepIssued = true
      injectProfessionalWriteRetryNotice = state.professionalRepairWriteRetryPath !== undefined
      injectProfessionalRepairNotice = !injectProfessionalWriteRetryNotice
    }
    const searchBudget = selectedSearchBudget(
      verified.manifest.executionBudgets.search,
      state.searchBudgetTierId,
    )
    const downstream = await next()
    for (const skill of invokedSkillNames(downstream.kind === 'enter' ? downstream.messages : [])) {
      activateObservedSkill(state, professional, skill)
    }
    if (state.professionalSkills.size > 0) {
      state.required.set(verified.manifest.delivery.professionalReceipt.id, verified.manifest.delivery.professionalReceipt)
    }
    if (downstream.kind === 'reject') {
      if (!preserveStoredCheckpoint) await persistDeliveryState(checkpointStore, agent, state)
      return downstream
    }
    let effectiveMessages = resumeContext === undefined
      ? downstream.messages
      : [...downstream.messages, resumeContext]
    if (injectProfessionalRepairNotice) {
      effectiveMessages = [...effectiveMessages, createUserMessage({
        content: [{
          type: 'text',
          text: '这是本轮唯一的自动修正步骤。不得再读取技能、模板、示例、目录、网页或运行时源码。'
            + '如必须核对被拒内容，只能重读诊断对应的同一候选文件，或本轮已经成功写入的精确源文件。请在一次 run_code 中完成该读取、必要写入或生成，并在同一次程序末尾重新调用 gongchuang_professional_validate。'
            + '若要覆盖本轮已写入的候选文件，必须先在同一次 run_code 中重读该精确文件，再写入并校验，避免文件并发保护拒绝覆盖。'
            + '不得把本步骤用成只读取、打印候选后等待下一轮；这种调用会耗尽唯一修正机会。诊断已经给出明确数字时，直接补齐证据或复算后重新提交。'
            + 'deliveryProfileId 必须与被拒调用保持一致：原调用省略则继续省略，原调用已有精确签名画像 ID 则原样保留；除非诊断明确要求，否则不得新增、猜测或改写画像 ID。'
            + '若诊断只是数字的证据或复算绑定缺口，保持候选文件不变，在重新校验参数中补齐所有派生数值的 calculations，不得只提交代表性指标。'
            + '若未绑定数字来自已签名计算或 run-preflight 输出，保持候选正文不变，只添加一条 status=calculated 的证据，source 必须逐字填写该操作 ID，values 省略或写空数组；不得把它改写成普通 calculation，也不得手抄该数字。'
            + '若诊断包含“政策选择链与官方原文”，保持候选正文不变并修正证据参数：签名技能参考文件不是客户文件，政策行必须使用 kind=official-policy、status=verified，sourceUrl 与 values 逐字来自本轮同一受信任读取回执，不得写成 user-provided。'
            + '若这是文件的 chat 预校验且本步骤未返回 formal，宿主会再开放且只开放一个文件生成步骤；必须在该步骤内生成文件并按返回路径完成检查，随后宿主保留带“待完善”标记的文件和诊断并结束本轮。',
        }],
        source: {
          kind: 'plugin',
          plugin: 'gongchuang-policy-gate',
          form: 'notice',
          summary: '专业修正窗口已限为一步',
        },
      })]
    }
    if (injectProfessionalWriteRetryNotice) {
      effectiveMessages = [...effectiveMessages, createUserMessage({
        content: [{
          type: 'text',
          text: `上一步已完成唯一一次专业内容修正，但覆盖 ${state.professionalRepairWriteRetryPath ?? '<unknown>'} 时触发文件并发保护。`
            + '本步骤只补偿该机械写入冲突：在同一次 run_code 中重读上述精确文件，写入上一步已经形成的修正内容，并立即重新调用 gongchuang_professional_validate。'
            + '不得重新分析、改写正文、读取其他文件、加载技能、检索或变更 deliveryProfileId；本次机械续写后无论结果如何都必须停止。',
        }],
        source: {
          kind: 'plugin',
          plugin: 'gongchuang-policy-gate',
          form: 'notice',
          summary: '文件并发保护仅续写一次',
        },
      })]
    }
    if (state.genericArtifactRequested && !state.genericArtifactNoticeInjected) {
      state.genericArtifactNoticeInjected = true
      effectiveMessages = [...effectiveMessages, createUserMessage({
        content: [{
          type: 'text',
          text: '普通文件交付规则：这不是政策、申报或企业专业校验任务，无需调用 gongchuang_professional_validate。'
            + '每份报告正文只生成一次；用户未明确指定文件格式时只交付一份 DOCX，不同时生成同一正文的 PDF。只有明确要求 PDF 时才生成 PDF，HTML 中间源不得发布。'
            + '生成并确认最终文件可打开后，必须对每个最终 DOCX、PDF、XLSX、PPTX 或 HTML 文件分别调用一次 gongchuang_artifact_probe，参数使用该文件的实际绝对路径；该工具负责在最终回答下方发布“打开文件”入口。'
            + '不得发布构建脚本、临时图片、中间文件或已删除文件。',
        }],
        source: {
          kind: 'plugin',
          plugin: 'gongchuang-policy-gate',
          form: 'notice',
          summary: '普通文件交付入口',
        },
      })]
    }
    const searchBudgetReached = state.searchBudgetActive
      && (step >= searchBudget.maxSteps
        || (state.searchCalls >= searchBudget.maxSearchCalls
          && state.fetchCalls >= searchBudget.maxFetchCalls))
    if (searchBudgetReached && !state.searchFinalNoticeInjected) {
      state.searchFinalNoticeInjected = true
      effectiveMessages = [...effectiveMessages, createUserMessage({
        content: [{
          type: 'text',
          text: `洞见联网检索已按“${searchBudget.label}”收束：本轮最多 ${String(searchBudget.maxSearchCalls)} 次联网发现、${String(searchBudget.maxFetchCalls)} 次网页原文读取。不得再调用 web_search、web_fetch 或洞见证据检索工具。`
            + '请仅依据本轮已取得并有回执的来源立即形成结论；无法从原文确认的内容明确标为待动态核验。'
            + '调用 gongchuang_professional_validate 时，verified 证据优先省略 toolCallId，让宿主按精确 sourceUrl 与逐字 values 自动绑定；只有同址重复输出无法区分时才原样复制回执 ID。values 不得写概括、推断或“HTTP 200 可访问”等改写；解释只写入 candidateText。'
            + '客户文件 read/read_image、已签名 gongchuang_skill_operation 或 PaddleOCR MCP 提取结果中的事实使用 user-provided，并逐字填写 values；宿主自动绑定唯一读取回执，只有多个读取结果含有相同取值时才原样填写对应 toolCallId。'
            + '用于支撑政策结论的政府通知或政府官网转载，已核验时 kind 必须填写 official-policy。'
            + '访问时间必须复制相关回执的 accessedAt；如需显式填写只能放入 evidence.asOf，不得放入 values。宿主会把该真实时间写入 asOf 并自动加入证据 values，禁止从工作区名称或模型上下文推测日期。'
            + '仅在对话中交付正文时，完成洞见专业校验后的下一条最终消息必须逐字输出本次 candidateText；不得添加校验状态、哈希、证据条数或“以下为”等前后缀，不得改动引号、链接、标点或空白。文件流程仍须继续生成、artifact 校验与剩余交付检查，不能因检索收束或专业校验通过而提前结束。不得继续扩大检索。',
        }],
        source: {
          kind: 'plugin',
          plugin: 'gongchuang-policy-gate',
          form: 'notice',
          summary: '联网检索预算已收束',
        },
      })]
    }
    if (state.professionalSkills.size === 0 || state.noticeInjected) {
      if (!preserveStoredCheckpoint) await persistDeliveryState(checkpointStore, agent, state)
      return { kind: 'enter', messages: effectiveMessages }
    }
    state.noticeInjected = true
    for (const skill of state.professionalSkills) state.notifiedProfessionalSkills.add(skill)
    const decision: PreStepDecision = {
      kind: 'enter', messages: [...effectiveMessages, createUserMessage({
        content: [{ type: 'text', text: professionalNotice(state, professional, professional.ruleVersion) }],
        source: {
          kind: 'plugin',
          plugin: 'gongchuang-policy-gate',
          form: 'notice',
          summary: '洞见专业执行链已锁定',
        },
      })],
    }
    if (!preserveStoredCheckpoint) await persistDeliveryState(checkpointStore, agent, state)
    return decision
  }, { global: true, prepend: true })

  // Deny wins without invoking downstream listeners. Ask delegates and then
  // keeps the stricter of the two decisions; allow always delegates.
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    if (exec.signal.aborted) return { kind: 'deny', reason: '洞见门禁：调用已取消' }
    if (exec.agent === undefined && !verified.manifest.tools.allowUnattributed) {
      return { kind: 'deny', reason: '洞见门禁：禁止无归属主体的工具调用' }
    }
    if (matches(deniedTools, exec.name)) {
      return { kind: 'deny', reason: `洞见门禁：工具 ${exec.name} 已被签名策略禁止` }
    }
    // Tool-name denials do not cover `bash` invoking rm. This rejects direct
    // destructive commands, not arbitrary program effects; the OS sandbox
    // still owns confinement. Never suggest re-encoding a rejected command.
    const command = objectRecord(exec.arguments)?.command
    if (typeof command === 'string'
      && ((exec.name === 'bash' && /(?:^|[;&|\n])\s*(?:sudo\s+)?(?:command\s+)?(?:\/[^\s;|&]+\/)?(?:rm|rmdir|unlink|shred)\s/u.test(command))
        || (exec.name === 'pwsh' && /(?:^|[;&|\n])\s*(?:Remove-Item|rm|ri|rmdir|rd|del|erase)\s/iu.test(command)))) {
      return {
        kind: 'deny',
        reason: '禁止通过命令永久删除文件。请保留已有文件，在本轮授权目录内使用新文件名或新建独立临时目录。确需清理时使用客户端的回收站操作；不得改用其他命令或脚本绕过。',
      }
    }
    if (exec.agent !== undefined) {
      const state = deliveryStates.get(exec.agent)
      const repairDiscoveryTool = exec.name === 'skill'
        || exec.name === 'read'
        || exec.name === 'read_image'
        || exec.name === 'glob'
        || searchBudgetToolKind(exec.name) !== undefined
        || enterpriseSourceProvider(exec.name) !== undefined
      const repairDiscoveryCommand = typeof command === 'string'
        && (exec.name === 'bash' || exec.name === 'pwsh')
        && /(?:^|[;&|\n])\s*(?:(?:command|builtin)\s+)?(?:pwd|ls|find|rg|grep|cat|head|tail|sed)\b/iu.test(command)
      const knownPathDiscoveryCommand = typeof command === 'string'
        && (exec.name === 'bash' || exec.name === 'pwsh')
        && /(?:^|[;&|\n])\s*(?:(?:command|builtin)\s+)?(?:pwd|ls|find|tree)\b/iu.test(command)
      if (state !== undefined && state.professionalSkills.size > 0
        && hasClosedExactFileInput(state.userEvidenceText)
        && (exec.name === 'glob' || knownPathDiscoveryCommand)) {
        return {
          kind: 'deny',
          reason: '用户已给出精确输入文件路径，本轮不得再用 pwd、glob、find、ls 或 tree 重新发现文件。请直接读取该文件；技能引用资料按 skill 回执给出的 Base directory 精确读取。',
        }
      }
      const repairReadArguments = exec.name === 'read' || exec.name === 'read_image'
        ? objectRecord(exec.arguments)
        : undefined
      // DSH 的 read SDK 使用 file_path，旧测试夹具使用 path。修正窗口必须
      // 同时识别两种真实参数形态，否则“允许重读同一候选”会在运行时被
      // 自己的门禁误拒绝，直接把一次可修复结果降成待完善稿。
      const repairReadPath = repairReadArguments?.path ?? repairReadArguments?.file_path
      let readsAllowedRepairFile = false
      if (typeof repairReadPath === 'string' && state !== undefined) {
        const workspaceRoot = professionalWorkspaceRoot(exec)
        const canonicalPath = canonicalWorkspacePath(workspaceRoot, repairReadPath)
        const rejectedArtifactPath = state.professionalRepairArtifactPath === undefined
          ? undefined
          : canonicalWorkspacePath(workspaceRoot, state.professionalRepairArtifactPath)
        // 唯一修正步骤有时需要从客户原件补齐逐字证据。这里只放行本轮已成功
        // 读取并形成受信任回执的同一路径，而且路径必须仍位于当前工作区内。
        // 不能借修正窗口读取同目录其他资料、签名技能资产或替换后的符号链接。
        const trustedSourcePath = canonicalPath !== undefined
          && [...state.evidenceReceipts.values()].some(receipt => receipt.sourcePaths.some(sourcePath =>
            canonicalWorkspacePath(workspaceRoot, sourcePath) === canonicalPath))
        readsAllowedRepairFile = canonicalPath !== undefined
          && (canonicalPath === rejectedArtifactPath
            || state.authoredArtifactPaths.has(canonicalPath)
            || trustedSourcePath)
      }
      if (state?.professionalRepairPending && state.professionalRepairStepIssued
        && (repairDiscoveryCommand || (repairDiscoveryTool && !readsAllowedRepairFile))) {
        return {
          kind: 'deny',
          reason: '本轮已进入唯一一次专业修正步骤。只允许重读诊断对应的同一候选文件、本轮已有受信任读取回执的精确输入文件或本轮已成功写入的精确源文件；不得列目录、读取其他资料、检索、加载技能或探查运行时。请在当前 run_code 内完成必要修改并立即重新校验。',
        }
      }
      const sourceCallKey = enterpriseSourceCallKey(exec)
      if (state !== undefined && sourceCallKey !== undefined
        && (state.enterpriseSourceFailures.get(sourceCallKey) ?? 0) >= 2) {
        return {
          kind: 'deny',
          reason: '同一企业数据调用已用完一次瞬时故障重试。请切换下一数据源；不得再次请求同一授权或重复相同调用。',
        }
      }
      if (state?.awaitingEnterprisePanoramaMode && !isProfessionalChoiceSetupTool(exec)) {
        return {
          kind: 'deny',
          reason: '洞见门禁：企业全景报告尚未由用户选择 A、B 或 C。请先调用 ask_user_question 等待用户回答；回答前不得检索、生成文件或自行采用默认模式。',
        }
      }
      const kind = searchBudgetToolKind(exec.name)
      // The model can decide to search even when the user's wording did not
      // contain the launcher phrase from the signed policy.  Budget the actual
      // capability use as well as product-authored search prompts; otherwise a
      // professional task such as "找同行" could silently bypass the ceiling.
      if (state !== undefined && kind !== undefined) {
        state.searchBudgetActive = true
        const budget = selectedSearchBudget(
          verified.manifest.executionBudgets.search,
          state.searchBudgetTierId,
        )
        const callIds = kind === 'search' ? state.searchCallIds : state.fetchCallIds
        // 洞见搜索 MCP 是 web_search 的受控包装器。外层调用和其唯一的
        // `:gongchuang-search` 子调用属于同一次联网发现，不得重复消耗预算。
        const logicalCallId = searchBudgetLogicalCallId(exec.name, exec.callId)
        const alreadyCounted = callIds.has(logicalCallId)
        const used = callIds.size
        const limit = kind === 'search' ? budget.maxSearchCalls : budget.maxFetchCalls
        if (!alreadyCounted && state.searchFinalNoticeInjected) {
          return {
            kind: 'deny',
            reason: `“${budget.label}”的外部联网检索预算已用尽：禁止继续发现或读取网页；本地知识库和本机文件读取不计入该额度，仍可继续使用。请基于本轮已有证据立即校验并输出结论，缺失内容标为待动态核验。`,
          }
        }
        if (!alreadyCounted && used >= limit) {
          return kind === 'search'
            ? {
              kind: 'deny',
              reason: `“${budget.label}”的外部联网发现次数已达上限（${String(limit)} 次）：禁止继续搜索；本地知识库和本机文件读取不计入该额度，仍可继续使用。请对本轮已取得的官方来源链接使用 web_fetch 读取原文，或在读取证据足够后形成结论。`,
            }
            : {
              kind: 'deny',
              reason: `“${budget.label}”的外部网页原文读取次数已达上限（${String(limit)} 次）：禁止继续读取网页；本地知识库和本机文件读取不计入该额度，仍可继续使用。可在联网发现次数尚未用尽时继续搜索，否则请基于已取得证据形成结论。`,
            }
        }
        if (!alreadyCounted) callIds.add(logicalCallId)
        state.searchCalls = state.searchCallIds.size
        state.fetchCalls = state.fetchCallIds.size
      }
    }
    // A formal file mentioned as an INPUT is not a deliverable created by the
    // current turn. In particular, reading or OCRing an existing DOCX/PDF
    // must not activate the content/brand/visual/openability delivery chain.
    // Tool-side activation is reserved for actual file mutations and the
    // signed PDF renderer; explicit user requests for a formal deliverable are
    // still activated earlier from the signed prompt rules.
    if (exec.name === 'gongchuang_publish_files' && exec.agent !== undefined) {
      const state = deliveryStates.get(exec.agent)
      if (state?.artifactBinding !== undefined
        && state.required.has('artifact-openability')
        && !state.satisfied.has('artifact-openability')) {
        return {
          kind: 'deny',
          reason: '洞见门禁：专业文件必须先调用 gongchuang_artifact_probe 并通过可打开性检查，才能显示为最终交付文件。',
        }
      }
    }
    const observesProducedArtifact = isFormalArtifactMutation(exec) || exec.name === 'gongchuang_render_pdf'
    const observedArtifacts = observesProducedArtifact
      ? formalArtifactPaths(exec.arguments, undefined, new Set<string>(), professionalWorkspaceRoot(exec))
      : new Set<string>()
    if (exec.agent !== undefined && observedArtifacts.size > 0) {
      const state = deliveryStates.get(exec.agent)
      if (state === undefined) return { kind: 'deny', reason: '洞见门禁：正式文件调用缺少当前轮次状态' }
      if (state.professionalSkills.size > 0) {
        for (const path of observedArtifacts) state.formalArtifactPaths.add(path)
        activateFormalDelivery(state, professional, verified.manifest)
      }
    }
    const ours: PreToolDecision = matches(askedTools, exec.name)
      ? { kind: 'ask', reason: `洞见门禁：工具 ${exec.name} 需要用户确认` }
      : matches(allowedTools, exec.name)
        ? { kind: 'allow' }
        : { kind: 'deny', reason: `洞见门禁：工具 ${exec.name} 未列入签名策略` }
    if (ours.kind === 'deny') return ours
    const downstream = await next()
    if (downstream.kind === 'deny') return downstream
    if (ours.kind === 'ask' || downstream.kind === 'ask') {
      return ours.kind === 'ask' ? ours : downstream
    }
    return { kind: 'allow' }
  }, { global: true, prepend: true })

  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    const downstream = await next()
    const accepted = !result.isError && downstream.kind === 'accept'
    receipts.settle(exec, accepted)
    let evidenceReceipt: Readonly<EvidenceReceipt> | undefined
    if (exec.name === 'gongchuang_render_pdf' && exec.agent !== undefined) {
      const state = deliveryStates.get(exec.agent)
      const args = objectRecord(exec.arguments)
      const sourcePath = typeof args?.sourceArtifactPath === 'string'
        ? professionalArtifactPath(exec, args.sourceArtifactPath)
        : undefined
      const outputPath = typeof args?.outputPath === 'string'
        ? professionalArtifactPath(exec, args.outputPath)
        : undefined
      if (state !== undefined) {
        if (sourcePath !== undefined) state.formalArtifactPaths.delete(sourcePath)
        if (!accepted && outputPath !== undefined) state.formalArtifactPaths.delete(outputPath)
      }
    }
    if (accepted) {
      if ((isFormalArtifactMutation(exec) || exec.name === 'gongchuang_render_pdf')
        && formalArtifactPaths(exec.arguments, undefined, new Set<string>(), professionalWorkspaceRoot(exec)).size > 0) {
        receipts.invalidateArtifact(exec)
      }
      evidenceReceipt = receipts.recordEvidence(exec, result)
      if (exec.agent !== undefined) {
        const state = deliveryStates.get(exec.agent)
        const authoredPath = exec.name === 'write' ? workspaceMutationPath(exec) : undefined
        if (state !== undefined && authoredPath !== undefined) state.authoredArtifactPaths.add(authoredPath)
      }
    }
    let skillContractContext: ReturnType<typeof createUserMessage> | undefined
    let skillInstructions: ReturnType<typeof createUserMessage> | undefined
    let sourceFailureContext: ReturnType<typeof createUserMessage> | undefined
    if (result.isError && exec.agent !== undefined) {
      const state = deliveryStates.get(exec.agent)
      const mutationPath = workspaceMutationPath(exec)
      if (state !== undefined
        && state.professionalRepairPending
        && state.professionalRepairStepIssued
        && !state.professionalRepairWriteRetryUsed
      && result.error.info?.code === 'FS_STALE_VERSION'
        && mutationPath !== undefined
        && state.authoredArtifactPaths.has(mutationPath)) {
        // 乐观并发拒绝没有消耗新的专业判断。只为本轮已经写入的同一路径
        // 退回一次机械重读续写，第二次失败仍按原上限有限收束。
        state.professionalRepairStepIssued = false
        state.professionalRepairWriteRetryUsed = true
        state.professionalRepairWriteRetryPath = mutationPath
        sourceFailureContext = createUserMessage({
          content: [{
            type: 'text',
            text: `文件 ${mutationPath} 在专业修正写入时触发并发保护。宿主仅开放一次同路径重读续写；不得修改专业结论或读取其他资料。`,
          }],
          source: {
            kind: 'plugin',
            plugin: 'gongchuang-policy-gate',
            form: 'notice',
            summary: '文件并发保护仅续写一次',
          },
        })
      }
      const sourceCallKey = enterpriseSourceCallKey(exec)
      const provider = enterpriseSourceProvider(exec.name)
      if (state !== undefined && sourceCallKey !== undefined && provider !== undefined) {
        const terminal = enterpriseSourceFailureIsTerminal(result)
        const failures = terminal
          ? 2
          : Math.min(2, (state.enterpriseSourceFailures.get(sourceCallKey) ?? 0) + 1)
        state.enterpriseSourceFailures.set(sourceCallKey, failures)
        const providerLabel = provider === 'tianyancha' ? '天眼查' : '企查查'
        sourceFailureContext = createUserMessage({
          content: [{
            type: 'text',
            text: failures >= 2
              ? `${providerLabel}本次调用已停止。不得再次调用或重复申请授权；按顺序切换下一可用来源，仍缺关键事实时形成待完善稿，非关键事实标记为未核验。`
              : `${providerLabel}本次调用属于瞬时失败，只允许原参数重试一次；再次失败立即切换下一可用来源，不得扩大调用或重复授权。`,
          }],
          source: {
            kind: 'plugin',
            plugin: 'gongchuang-policy-gate',
            form: 'notice',
            summary: '企业数据源有限降级',
          },
        })
      }
    }
    if (accepted && exec.agent !== undefined && exec.name === 'skill') {
      const args = objectRecord(exec.arguments)
      const value = objectRecord(result.value)
      if (typeof args?.name === 'string' && value?.name === args.name) {
        // PTC 程序可能只打印技能正文的前几行。指引必须完整进入下一步，
        // 使用既有 additionalContexts 排在整次工具返回之后，不能直接插入会话。
        if (exec.parent !== undefined && typeof value.content === 'string') {
          skillInstructions = createUserMessage({
            content: [...result.content],
            source: { kind: 'plugin', plugin: 'gongchuang-policy-gate', form: 'instructions' },
          })
        }
        const state = deliveryStates.get(exec.agent)
        if (state !== undefined) {
          activateObservedSkill(state, professional, args.name)
          refreshEnterprisePanoramaMode(state)
          if (state.professionalSkills.size > 0) {
            state.required.set(
              verified.manifest.delivery.professionalReceipt.id,
              verified.manifest.delivery.professionalReceipt,
            )
          }
          const notice = state.contractSkills.has(args.name)
            ? skillOutputContractNotice(professional, args.name, state.responseDepth)
            : undefined
          const dependencyNotice = newlyRequiredSkillNotice(
            state,
            professional,
            verified.manifest.delivery.professionalReceipt.id,
          )
          if (notice !== undefined || dependencyNotice !== undefined) {
            skillContractContext = createUserMessage({
              content: [{
                type: 'text',
                text: [
                  notice === undefined ? undefined : `洞见技能输出契约：${args.name}。\n${notice}`,
                  dependencyNotice,
                ].filter((row): row is string => row !== undefined).join('\n'),
              }],
              source: {
                kind: 'plugin',
                plugin: 'gongchuang-policy-gate',
                form: 'notice',
                summary: '已激活技能输出契约',
              },
            })
          }
        }
      }
    }
    if (accepted && exec.agent !== undefined && exec.name === 'ask_user_question') {
      const state = deliveryStates.get(exec.agent)
      if (state !== undefined) {
        state.userEvidenceText = normalizeProfessionalCandidate(
          [state.userEvidenceText, resultEvidenceText(result)].filter(Boolean).join('\n'),
        )
        refreshEnterprisePanoramaMode(state)
      }
    }
    if (accepted && exec.agent !== undefined && exec.name === 'gongchuang_professional_validate') {
      const state = deliveryStates.get(exec.agent)
      const value = objectRecord(result.value)
      if (state !== undefined && value?.status === 'formal') {
        state.professionalRepairPending = false
        state.professionalRepairStepIssued = false
        state.professionalRepairWriteRetryUsed = false
        delete state.professionalRepairWriteRetryPath
        state.professionalRepairIssues = []
        delete state.professionalRepairCandidateText
        delete state.professionalRepairArtifactPath
      }
    }
    if (exec.agent !== undefined) {
      const state = deliveryStates.get(exec.agent)
      if (state !== undefined) await persistDeliveryState(checkpointStore, exec.agent, state, false)
    }
    if (downstream.kind !== 'accept') return downstream
    const additionalContexts = [skillInstructions, skillContractContext, sourceFailureContext]
      .filter((context): context is ReturnType<typeof createUserMessage> => context !== undefined)
    if (evidenceReceipt !== undefined) {
      const receiptGuidance = signedCalculationReceipt(evidenceReceipt)
        ? `这是已签名确定性操作回执；引用其输出时只提交一条 status=calculated 的证据，source 必须逐字填写 ${evidenceReceipt.operationId ?? '<operation-id>'}，values 省略或写空数组。宿主会自动绑定本回执并生成数值，禁止把它标为 user-provided、手抄数值或改写操作 ID。`
        : '外部核验结果列为 verified；客户文件的 read/read_image、已签名客户文件提取操作或 PaddleOCR MCP 提取结果列为 user-provided。两者都优先省略 evidence.toolCallId，让宿主按精确 sourceUrl 与逐字 values 自动绑定；只有多个回执包含同一取值、无法唯一判断时才原样复制此 ID。values 只能复制该工具输出中逐字出现的短片段，accessedAt 只填 evidence.asOf、不得放入 values；解释与推断写入 candidateText；禁止猜测或改写。'
      additionalContexts.push(createUserMessage({
        content: [{
          type: 'text',
          text: `洞见证据回执：toolCallId=${evidenceReceipt.toolCallId}；tool=${evidenceReceipt.toolName}；accessedAt=${evidenceReceipt.accessedAt}。`
            + receiptGuidance,
        }],
        source: {
          kind: 'plugin',
          plugin: 'gongchuang-policy-gate',
          form: 'notice',
          summary: '本轮受信任证据回执',
        },
      }))
    }
    if (additionalContexts.length === 0) return downstream
    return {
      ...downstream,
      additionalContexts: [...downstream.additionalContexts ?? [], ...additionalContexts],
    }
  })

  // A turn cannot close while an activated formal-delivery rule lacks trusted
  // receipts. Automatic page regression applies only to final PDFs; Office
  // artifacts retain their structural, content, branding, and openability
  // checks without an artificial Office-to-PDF conversion.
  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }): Promise<void> => {
    const state = deliveryStates.get(agent)
    if (state === undefined || state.turn !== turn) return
    if (signal.aborted) {
      // 用户在终态生成后点击停止，不应把已记录的待完善结果改成未完成执行。
      state.phase = state.terminalOutcome?.status ?? 'paused'
      await persistDeliveryState(checkpointStore, agent, state)
      return
    }
    try {
      if (state.terminalOutcome !== undefined) {
        state.phase = state.terminalOutcome.status
        return
      }
      if (state.awaitingEnterprisePanoramaMode) {
        // 普通文字提问也必须真的把控制权交还给用户；否则门禁 steer 会让
        // 模型在同一轮越过尚未回答的 A/B/C 选择并自行采用默认模式。
        if (asksForEnterprisePanoramaMode(latestAssistantText(agent, turn))) {
          state.terminalOutcome = Object.freeze({ status: 'waiting-user', issues: [] })
          state.phase = 'waiting-user'
          return
        }
        const problem = '企业全景报告尚未取得用户对 A、B 或 C 的真实选择。请调用 ask_user_question 等待回答；用户回答前不得检索、生成文件或自行选择模式。'
        if (state.correctionCount >= 1) {
          state.terminalOutcome = Object.freeze({ status: 'waiting-user', issues: [problem] })
          state.phase = 'waiting-user'
          return
        }
        state.correctionCount += 1
        agent.steer(createUserMessage({
          content: [{ type: 'text', text: `本轮必须等待用户选择后再继续。\n${problem}` }],
          source: {
            kind: 'plugin',
            plugin: 'gongchuang-policy-gate',
            form: 'notice',
            summary: '等待报告模式选择',
          },
        }))
        return
      }
      const problems: string[] = []
      const rendererUnavailable = ctx.get('gongchuangArtifactRenderer') === undefined
      const missing = [...state.required.values()].filter(receipt => !state.satisfied.has(receipt.id))
      const pdfArtifact = state.artifactBinding?.format === 'pdf'
      const visualNotApplicable = missing.filter(receipt => receipt.id === 'visual-inspection' && !pdfArtifact)
      for (const receipt of visualNotApplicable) state.satisfied.add(receipt.id)
      const applicableMissing = missing.filter(receipt => !visualNotApplicable.includes(receipt))
      const rendererBlocked = rendererUnavailable && pdfArtifact
        ? applicableMissing.filter(receipt => receipt.id === 'visual-inspection')
        : []
      const actionableMissing = rendererUnavailable && pdfArtifact
        ? applicableMissing.filter(receipt => receipt.id !== 'visual-inspection')
        : applicableMissing
      if (actionableMissing.length > 0) {
        problems.push('缺少受信任交付回执：')
        problems.push(...actionableMissing.map(receipt => `- ${receipt.label} (${receipt.id})`))
      }
      if (rendererBlocked.length > 0) {
        problems.push(
          '当前安装包未提供 PDF 自动视觉回归能力，本轮专业 PDF 无法完成。'
        + '请保留现有会话和文件；不要重试同一不可达工具，也不得发布成功回执。',
        )
      }
      const missingSkills = [...state.professionalSkills].filter(skill => !state.activatedSkills.has(skill)).sort()
      const professionalReceiptId = verified.manifest.delivery.professionalReceipt.id
      const subject = state.receiptSubjects.get(professionalReceiptId)
      if (missingSkills.length > 0) {
        if (subject !== undefined) {
          problems.push('专业正文内容校验已通过；执行链尚未完成。')
          problems.push(candidateCheckpoint(subject))
          problems.push('本轮只需激活下列缺失技能；不要重新校验、重写或重复输出候选正文。')
        }
        problems.push(`尚未激活 V${professional.ruleVersion} 必需技能：`)
        problems.push(...missingSkills.map(skill => `- ${skill}`))
      } else {
        if (state.requiresSpecificRoute
        && !state.activationSequence.some(skill => professional.routeResolutionSkills.has(skill))) {
          problems.push('尚未从项目总路由选择并激活具体专业 Skill，禁止回退为通用模型回答。')
        }
        const gateOrder = qualityGateOrderProblems(state, professional)
        if (gateOrder.length > 0) {
          problems.push('质量门禁执行顺序错误：')
          problems.push(...gateOrder.map(problem => `- ${problem}`))
        }
      }
      const answer = normalizeProfessionalCandidate(latestAssistantText(agent, turn))
      const hasFormalArtifactGate = [...state.required.keys()].some(id => id !== professionalReceiptId)
      let expandedCandidateSha256: string | undefined
      // chat 候选是正式文件的正文检查点，不是文件交付后的聊天回复。
      // 文件已绑定全部正式回执时，不能要求最后一条回复逐字重放整份正文。
      if (missingSkills.length === 0 && subject !== undefined && !hasFormalArtifactGate && answer !== subject) {
        const subjectSha256 = createHash('sha256').update(subject).digest('hex')
        problems.push('最终回答与已通过专业校验的候选正文不一致。')
        problems.push(candidateCheckpoint(subject))
        if (state.expandedCandidateSha256 === subjectSha256) {
          problems.push(
            '完整候选已在上一条纠正中提供；下一条消息只逐字复用该候选，不得添加前后缀。'
          + '禁止重复调用专业校验；只有确需修改正文内容时，才校验完整新正文。',
          )
        } else {
          problems.push(
            '若只是多了校验状态、哈希、“以下为”等前后缀或格式发生漂移，禁止重复调用校验；'
          + '下一条消息只逐字复制下方已通过正文。只有确需修改正文内容时，才重新校验完整新正文。',
          )
          problems.push(`<validated-candidate>\n${subject}\n</validated-candidate>`)
          problems.push('输出时不得包含 validated-candidate 标签。')
          expandedCandidateSha256 = subjectSha256
        }
      }
      if (hasFormalArtifactGate && state.artifactBinding === undefined) {
        problems.push('正式文件尚未绑定实际文件身份与已校验正文。')
      }
      if (state.formalArtifactPaths.size > 1) {
        problems.push('同一轮检测到多个正式文件路径；V0.1 必须逐个文件完成独立校验与逐页验收。')
      }
      if (state.artifactBinding !== undefined) {
        try {
          assertArtifactMatchesBinding(state.artifactBinding, inspectProfessionalArtifact(state.artifactBinding.path))
        } catch (error: unknown) {
          problems.push(`正式文件在轮次结束前发生漂移或不可读取：${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (missingSkills.length === 0 && !hasFormalArtifactGate && state.markerGroups.size > 0) {
        const missingGroups = missingMarkerGroups(state, answer)
        if (missingGroups.length > 0) {
          problems.push('专业输出缺少强制结构或证据状态：')
          problems.push(...missingGroups.map(group => `- ${group}`))
        }
      }
      if (problems.length === 0) {
        state.phase = 'formal'
        return
      }
      const unavailableReceipts = actionableMissing.filter(receipt => receipt.producerTools.every(
        producer => ctx.tools.get(producer, agent) === undefined,
      ))
      const unavailable = [
        ...(rendererBlocked.length > 0 ? ['PDF 自动视觉回归能力不可用'] : []),
        ...unavailableReceipts.map(receipt => `${receipt.label}的受信任回执生产者不可用`),
      ]
      if (unavailable.length > 0) {
        state.terminalOutcome = Object.freeze({
          status: 'failed',
          issues: Object.freeze([...unavailable, ...problems]),
        })
        state.phase = 'failed'
        agent.steer(createUserMessage({
          content: [{
            type: 'text',
            text: `本轮因基础能力不可用而停止，不得自动重试。请向用户说明已保留会话和已有文件。\n${unavailable.join('；')}`,
          }],
          source: {
            kind: 'plugin',
            plugin: 'gongchuang-policy-gate',
            form: 'notice',
            summary: '专业执行已有限停止',
          },
        }))
        return
      }
      if (state.correctionCount >= 1) {
        let artifactPath: string | undefined
        if (state.formalArtifactPaths.size === 1) {
          try {
            artifactPath = draftArtifactCopy([...state.formalArtifactPaths][0] as string)
          } catch (error: unknown) {
            state.terminalOutcome = Object.freeze({
              status: 'failed',
              issues: Object.freeze([...problems, ...professionalFailureIssues(error)]),
            })
            state.phase = 'failed'
            return
          }
        }
        state.terminalOutcome = Object.freeze({
          status: 'draft',
          issues: Object.freeze([...problems]),
          ...(subject === undefined || hasFormalArtifactGate ? {} : { candidateText: subject }),
          ...(artifactPath === undefined ? {} : { artifactPath }),
        })
        state.phase = 'draft'
        agent.steer(createUserMessage({
          content: [{
            type: 'text',
            text: `本轮唯一一次自动修正仍未满足正式合同。现在停止修正和校验，明确以“待完善稿”收束；保留已有内容并逐项列出缺口。${artifactPath === undefined ? '' : `只发布该待完善文件：${artifactPath}`}`,
          }],
          source: {
            kind: 'plugin',
            plugin: 'gongchuang-policy-gate',
            form: 'notice',
            summary: '待完善稿已有限收束',
          },
        }))
        return
      }
      state.correctionCount += 1
      if (expandedCandidateSha256 !== undefined) state.expandedCandidateSha256 = expandedCandidateSha256
      agent.steer(createUserMessage({
        content: [{
          type: 'text',
          text: `这是本轮唯一一次自动修正机会。只处理下列确定性缺口；不得重复读取、检索或扩大任务。修正后至多再校验一次，仍未通过必须以待完善稿结束。\n${problems.join('\n')}`,
        }],
        source: {
          kind: 'plugin',
          plugin: 'gongchuang-policy-gate',
          form: 'notice',
          summary: '交付门禁未通过',
        },
      }))
    } finally {
      await persistDeliveryState(checkpointStore, agent, state)
    }
  })
}
