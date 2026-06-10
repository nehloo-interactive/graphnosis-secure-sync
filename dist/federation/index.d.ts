import type { GraphId, SubgraphBudget } from '../types.js';
import { TIER_CAPS, type PolicyConfig, type SensitivityTier } from '../policy/index.js';
export interface CandidateNode {
    graphId: GraphId;
    nodeId: string;
    score: number;
    text: string;
    type?: string;
    tags?: string[];
}
export interface FederatedQueryRunner {
    runQuery(graphId: GraphId, query: string, k: number): Promise<CandidateNode[]>;
}
export interface AttachedGraphAudit {
    graphId: GraphId;
    tier: SensitivityTier;
    nodesIncluded: number;
    tokensIncluded: number;
}
export interface FederatedSubgraph {
    byGraph: Map<GraphId, CandidateNode[]>;
    prompt: string;
    tokensUsed: number;
    nodesIncluded: number;
    /** Per-graph audit trail. Used by the desktop app's prompt-context inspector. */
    audit: AttachedGraphAudit[];
}
export declare function federatedQuery(runner: FederatedQueryRunner, graphIds: GraphId[], query: string, cfg: PolicyConfig, budget?: SubgraphBudget, 
/**
 * Engrams the caller has explicitly authorised (e.g. an app-side per-engram
 * consent gate approved an explicitly-named sensitive engram). These bypass
 * the shareability filter so a consented sensitive recall actually returns
 * data — still clamped by the per-tier budget cap. Proactive recall passes
 * nothing here, so sensitive stays excluded by default.
 */
allowGraphIds?: GraphId[]): Promise<FederatedSubgraph>;
export { TIER_CAPS };
//# sourceMappingURL=index.d.ts.map