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
export declare function federatedQuery(runner: FederatedQueryRunner, graphIds: GraphId[], query: string, cfg: PolicyConfig, budget?: SubgraphBudget): Promise<FederatedSubgraph>;
export { TIER_CAPS };
//# sourceMappingURL=index.d.ts.map