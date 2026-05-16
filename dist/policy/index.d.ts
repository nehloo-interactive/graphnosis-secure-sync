import type { GraphId, SubgraphBudget } from '../types.js';
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
export declare const DEFAULT_BUDGET: SubgraphBudget;
export declare const TIER_CAPS: Record<SensitivityTier, {
    maxTokens: number;
    maxNodes: number;
}>;
export declare function tierOf(cfg: PolicyConfig, graphId: GraphId): SensitivityTier;
export declare function shouldShare(cfg: PolicyConfig, graphId: GraphId): boolean;
export declare function shareableGraphs(cfg: PolicyConfig, graphIds: GraphId[]): GraphId[];
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