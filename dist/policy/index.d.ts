import type { GraphId, SubgraphBudget } from '../types.js';
/**
 * Canonical sensitivity ladder: public → deidentified → sensitive.
 * Legacy middle-tier value `personal` is still accepted on GraphPolicy input
 * and normalized to `deidentified` via {@link normalizeSensitivityTier}.
 */
export type SensitivityTier = 'public' | 'deidentified' | 'sensitive';
/** Pre-rename middle tier — still accepted on read / policy config. */
export type LegacySensitivityTierAlias = 'personal';
export type SensitivityTierInput = SensitivityTier | LegacySensitivityTierAlias;
export interface GraphPolicy {
    graphId: GraphId;
    shareWithAi: boolean;
    /** Default `'deidentified'` if unset. Tightens the AI-visible budget per graph. */
    tier?: SensitivityTierInput;
    excludeNodeTypes?: string[];
    excludeTags?: string[];
}
export interface PolicyConfig {
    defaultBudget: SubgraphBudget;
    graphs: GraphPolicy[];
}
export declare const DEFAULT_BUDGET: SubgraphBudget;
/** Map legacy `personal` → `deidentified`. Unknown / missing → deidentified. */
export declare function normalizeSensitivityTier(raw: unknown): SensitivityTier;
export declare const TIER_CAPS: Record<SensitivityTier, {
    maxTokens: number;
    maxNodes: number;
}>;
export declare function tierOf(cfg: PolicyConfig, graphId: GraphId): SensitivityTier;
/** Why an engram is not shareable. Tier outranks the flag. */
export type WithheldReason = 
/** Its tier is not shareable with an AI at all. Overrides `shareWithAi`. */
'sensitive-tier'
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
export declare function withholdReason(cfg: PolicyConfig, graphId: GraphId): WithheldReason | undefined;
export declare function shouldShare(cfg: PolicyConfig, graphId: GraphId): boolean;
export declare function shareableGraphs(cfg: PolicyConfig, graphIds: GraphId[], allowGraphIds?: GraphId[]): GraphId[];
/** Per-graph budget = min(requested, tier cap). */
export declare function budgetFor(cfg: PolicyConfig, graphId: GraphId, requested: SubgraphBudget): {
    maxTokens: number;
    maxNodes: number;
};
export declare function estimateTokens(text: string): number;
export declare function redactNode(node: {
    type?: string;
    tags?: string[];
    content?: string;
}, policy: GraphPolicy | undefined): boolean;
//# sourceMappingURL=index.d.ts.map