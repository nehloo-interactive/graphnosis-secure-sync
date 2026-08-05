import type { GraphId, SubgraphBudget } from '../types.js';

// Policy = what gets attached to which prompt. Per-graph rules cap how much
// context an AI can pull, regardless of what it asks for. The federation pass
// enforces this *after* the AI's requested budget — so a maxed-out `recall`
// against a `sensitive` graph still only yields the tier's cap.

export type SensitivityTier = 'public' | 'personal' | 'sensitive';

export interface GraphPolicy {
  graphId: GraphId;
  shareWithAi: boolean;
  /** Default `'personal'` if unset. Tightens the AI-visible budget per graph. */
  tier?: SensitivityTier;
  excludeNodeTypes?: string[];
  excludeTags?: string[];
}

export interface PolicyConfig {
  defaultBudget: SubgraphBudget;
  graphs: GraphPolicy[];
}

export const DEFAULT_BUDGET: SubgraphBudget = {
  maxTokens: 2_000,
  maxNodes: 20,
  perGraphMinTokens: 200,
};

// Per-tier hard caps applied *after* the user-/AI-requested budget.
// A request asking for 5000 tokens against a sensitive graph still gets ≤ 500.
export const TIER_CAPS: Record<SensitivityTier, { maxTokens: number; maxNodes: number }> = {
  public:    { maxTokens: 8_000, maxNodes: 50 },
  personal:  { maxTokens: 2_000, maxNodes: 20 },
  sensitive: { maxTokens:   500, maxNodes:  5 },
};

export function tierOf(cfg: PolicyConfig, graphId: GraphId): SensitivityTier {
  return cfg.graphs.find(g => g.graphId === graphId)?.tier ?? 'personal';
}

/** Why an engram is not shareable. Tier outranks the flag. */
export type WithheldReason =
  /** Its tier is not shareable with an AI at all. Overrides `shareWithAi`. */
  | 'sensitive-tier'
  /** `shareWithAi: false` — this engram is switched off for AI use. */
  | 'sharing-disabled';

/**
 * Why `shouldShare` refuses, or `undefined` when it does not.
 *
 * Exists so an audit can state WHICH guarantee fired for a withheld engram
 * without re-deriving the rule and slowly diverging from the real decision:
 * `shouldShare` is defined in terms of this function, so there is exactly one
 * implementation of the rule and the audit cannot disagree with the filter.
 */
export function withholdReason(cfg: PolicyConfig, graphId: GraphId): WithheldReason | undefined {
  const g = cfg.graphs.find(x => x.graphId === graphId);
  // Hard backstop: a `sensitive`-tier engram is NEVER federated to an AI,
  // regardless of its `shareWithAi` flag. The two axes are settable
  // independently (and an env-supplied GRAPHNOSIS_POLICY bypasses the host's
  // safety derivation that normally forces shareWithAi=false for sensitive), so
  // this re-checks the tier here as an independent guard against that decoupling.
  if (g?.tier === 'sensitive') return 'sensitive-tier';
  if (g && !g.shareWithAi) return 'sharing-disabled';
  // No policy entry ⇒ shareable, unchanged.
  return undefined;
}

export function shouldShare(cfg: PolicyConfig, graphId: GraphId): boolean {
  return withholdReason(cfg, graphId) === undefined;
}

export function shareableGraphs(cfg: PolicyConfig, graphIds: GraphId[], allowGraphIds?: GraphId[]): GraphId[] {
  // `allowGraphIds` is an explicit allow-list for engrams the CALLER has already
  // authorised out-of-band (e.g. the app's per-engram consent gate approved an
  // explicitly-named sensitive engram). Those bypass the share filter — but only
  // the share filter; the per-tier budget cap in `budgetFor` still clamps how
  // much they can contribute (sensitive = 500 tok / 5 nodes). Without an
  // allow-list this is unchanged: sensitive stays non-shareable (proactive
  // recall never leaks it).
  return graphIds.filter(g => shouldShare(cfg, g) || allowGraphIds?.includes(g));
}

/** Per-graph budget = min(requested, tier cap). */
export function budgetFor(cfg: PolicyConfig, graphId: GraphId, requested: SubgraphBudget): { maxTokens: number; maxNodes: number } {
  const cap = TIER_CAPS[tierOf(cfg, graphId)];
  return {
    maxTokens: Math.min(requested.maxTokens, cap.maxTokens),
    maxNodes:  Math.min(requested.maxNodes,  cap.maxNodes),
  };
}

// Very rough token estimate. The sidecar can swap in a real tokenizer if needed.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function redactNode(
  node: { type?: string; tags?: string[]; content?: string },
  policy: GraphPolicy | undefined,
): boolean {
  if (!policy) return false;
  if (node.type && policy.excludeNodeTypes?.includes(node.type)) return true;
  if (node.tags && policy.excludeTags && node.tags.some(t => policy.excludeTags!.includes(t))) return true;
  return false;
}
