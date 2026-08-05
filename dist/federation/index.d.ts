import type { GraphId, SubgraphBudget } from '../types.js';
import { TIER_CAPS, type PolicyConfig, type SensitivityTier, type WithheldReason } from '../policy/index.js';
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
/**
 * What became of one engram in this request.
 * - `ok`       — queried; the counts on the row are the truth about it.
 * - `failed`   — queried, but it threw or never answered. It contributed
 *                NOTHING, and carries no counts at all: a zero here would read
 *                as "no match" when what it means is "unknown".
 * - `withheld` — never queried. Policy kept it out, and the row is the evidence
 *                that the guarantee fired. Lives on `sub.withheld`, never in
 *                `sub.audit` — see `WithheldGraphAudit`.
 */
export type GraphRecallStatus = 'ok' | 'failed' | 'withheld';
/** An engram federation asked, that answered. Its counts are the truth about it. */
export interface AnsweredGraphAudit {
    graphId: GraphId;
    tier: SensitivityTier;
    status: 'ok';
    nodesIncluded: number;
    tokensIncluded: number;
    /**
     * Nodes this engram matched (and passed redaction) that were dropped because
     * an identical piece of content was kept from another copy. Explains why an
     * engram contributed fewer nodes than it matched, without implying the
     * evidence was lost — a verified-identical copy is in the context.
     */
    duplicatesDropped: number;
}
/**
 * An engram federation asked, that did not answer.
 *
 * WHY IT CARRIES NO COUNTS. A failed engram contributed nothing, so every count
 * on it would be zero — and a zero is exactly what a caller reads as "this
 * engram had no matching memory". `nodesIncluded: 0` on a row that means
 * "unknown" is the silent false negative this release exists to remove, so the
 * field does not exist: `audit.filter(a => a.nodesIncluded > 0)` cannot compile
 * without first narrowing on `status`, which is the moment the caller has to
 * decide what a failed engram means for whatever it is about to render.
 */
export interface FailedGraphAudit {
    graphId: GraphId;
    tier: SensitivityTier;
    status: 'failed';
    /** Failure detail, e.g. `sqlite: database is locked` or `timed out after 25000ms`. */
    error: string;
}
/**
 * One engram federation actually asked.
 *
 * A caller that renders an audit MUST distinguish `failed` from `ok`: a
 * federated answer assembled from an unknown subset of the user's engrams is
 * worse than no answer, because nothing downstream can tell "your engram holds
 * no such memory" from "we could not read it".
 */
export type QueriedGraphAudit = AnsweredGraphAudit | FailedGraphAudit;
/**
 * An engram policy kept OUT of the request. It was never queried.
 *
 * WHY THE ROW EXISTS AT ALL: `shareableGraphs` filters withheld engrams before
 * anything is queried, so the audit used to omit them entirely — a `sensitive`
 * engram excluded by tier and a `shareWithAi: false` engram excluded by flag
 * were simply not in the array. That made the one row that PROVES the privacy
 * guarantee fired indistinguishable from an engram that was never in scope, and
 * left every consumer to recover the difference by joining the audit against
 * the ids it requested — a step nothing forced it to take. In a consent-gated
 * system the proof of withholding is a first-class result, not an omission.
 *
 * WHY IT CARRIES NOTHING BUT THE FACT AND THE REASON: this is a separate type
 * rather than another `status` value on a shared row, so it CANNOT carry node
 * counts, token counts or match statistics — not by convention, but because
 * those fields do not exist on it. An audit whose purpose is to prove an engram
 * was not read must never become a channel for inferring what is in it: a row
 * saying "0 included, 14 matches suppressed" would tell the caller the
 * sensitive engram holds 14 relevant memories, which is exactly what
 * withholding exists to prevent it from learning. `tier` is included because
 * the caller supplied the policy that set it, so it discloses nothing the
 * caller did not already provide.
 *
 * WHY IT IS NOT IN `audit`. Withheld rows used to be appended to the same array
 * as the queried ones. Refusing to put counts ON the row does not close the
 * channel if the row still lands in the array a caller COUNTS: every existing
 * `sub.audit.length` silently grew by the number of withheld engrams, and the
 * desktop app's "(N other engram(s) searched, no matches.)" footer — text that
 * goes to the model — went from 1 to 3 on a scope holding one sensitive and one
 * sharing-disabled engram. Measured, not inferred. Worse, it was invisible to
 * the compiler: `audit.length` typechecks identically before and after, so the
 * one hazard the union could not flag was the one the merge introduced. A
 * withheld engram therefore lives in its own array, where its presence cannot
 * be summed with anything and `audit.length` keeps meaning what it has always
 * meant — engrams asked.
 *
 * The consumer this was supposed to serve is served better: telling a
 * deliberately-withheld engram from one that was never in scope needs no join
 * against the requested ids, it is a direct read of `withheld`.
 */
export interface WithheldGraphAudit {
    graphId: GraphId;
    tier: SensitivityTier;
    status: 'withheld';
    /** Which rule kept it out. See `withholdReason` in the policy module. */
    reason: WithheldReason;
}
/** An engram that was asked and did not answer. */
export interface GraphFailure {
    graphId: GraphId;
    /**
     * The failed engram's tier, carried here so a caller can apply a stricter
     * rule to the consented-sensitive case without re-deriving it from policy.
     *
     * WHY A FAILED `sensitive` ENGRAM DESERVES A STRICTER RULE: a sensitive
     * engram only reaches federation through `allowGraphIds` — the user just
     * passed an explicit, per-request consent gate naming it (`shouldShare`
     * refuses sensitive unconditionally otherwise). Their intent was specifically
     * "answer me using my health / finance / legal engram". A fluent answer built
     * from the remaining engrams hides the gap in exactly the place where a false
     * negative does the most damage — "nothing in your records mentions this"
     * when in truth nothing was read. Silence is cheap in a notes engram and
     * dangerous here.
     *
     * Federation does NOT decide what to do about that, because the right answer
     * differs per surface: a background plasticity pass can reasonably proceed on
     * partial data, while a user-facing recall must disclose or refuse. The
     * invariant federation enforces is narrower and absolute — never let the
     * model assert absence when a consented engram went unread — and the union on
     * `complete` enforces it without discarding the evidence that did arrive.
     */
    tier: SensitivityTier;
    /** `timeout` = the engram never answered within its allowance; `error` = it threw. */
    reason: 'error' | 'timeout';
    /** Human-readable detail, e.g. `sqlite: database is locked` or `timed out after 25000ms`. */
    error: string;
}
interface FederatedSubgraphBase {
    byGraph: Map<GraphId, CandidateNode[]>;
    tokensUsed: number;
    nodesIncluded: number;
    /**
     * One row per engram federation ASKED, in request order. Used by the desktop
     * app's prompt-context inspector.
     *
     * `audit.length` is the number of engrams queried and nothing else — engrams
     * policy kept out are in `withheld`, never here. See `WithheldGraphAudit`.
     */
    audit: QueriedGraphAudit[];
    /**
     * Engrams policy kept out of this request, one row each, in request order.
     * Empty when nothing was withheld.
     *
     * This is the evidence the privacy guarantee fired, and it is USER-facing:
     * never render it into anything a model reads. See `WithheldGraphAudit`.
     */
    withheld: WithheldGraphAudit[];
}
/** Every shareable engram answered. `prompt` is safe to send as-is. */
export interface CompleteFederatedSubgraph extends FederatedSubgraphBase {
    complete: true;
    /** Rendered context covering every engram in scope. */
    prompt: string;
}
/**
 * At least one engram in scope did not answer. The evidence that DID arrive is
 * here in full — nothing is discarded — but the caller must decide what to do
 * about the gap before anything reaches a model.
 */
export interface IncompleteFederatedSubgraph extends FederatedSubgraphBase {
    complete: false;
    /** Non-empty. Which engrams went unread, and why. */
    failures: GraphFailure[];
    /**
     * Deliberately NOT called `prompt`. The only way to read a renderable context
     * off an incomplete result is to name it as partial, which makes the "I am
     * about to send an answer built on unread engrams" moment explicit at the
     * call site instead of implicit in a field a caller may never inspect.
     * Carries the `INCOMPLETE CONTEXT` banner (see `renderPrompt`) — but treat
     * that banner as the second line of defence, not the first: a caller that
     * builds its own prompt from `byGraph` (as the desktop app does) discards the
     * banner and must disclose the gap itself.
     */
    partialPrompt: string;
}
/**
 * The result of a federated recall.
 *
 * A UNION, not a flag, and deliberately so. `federatedQuery` used to be
 * all-or-nothing (`Promise.all`) — one broken engram cost the user every other
 * engram's answer. Tolerating per-graph failure fixes that but creates a worse
 * hazard if the degradation is merely *reported*: an answer assembled from an
 * unknown subset of the user's memory, indistinguishable from a complete one.
 * A boolean field can be ignored; a union cannot. Narrowing on `complete` is
 * the only way to reach a renderable prompt, so every consumer is forced to
 * confront the gap at compile time rather than discover it in production.
 *
 * Note the limit of the guarantee: `byGraph`, `audit`, `tokensUsed` and
 * `nodesIncluded` are common to both branches and so remain readable without
 * narrowing (TypeScript only demands narrowing for properties a branch lacks).
 * The rendered context is what reaches the model, so that is what the union
 * gates.
 */
export type FederatedSubgraph = CompleteFederatedSubgraph | IncompleteFederatedSubgraph;
/** Engrams that failed to answer. Empty ⇒ the result covers every shareable engram. */
export declare function federationFailures(sub: FederatedSubgraph): GraphFailure[];
export interface FederatedQueryOptions {
    /**
     * Per-engram wall-clock allowance. Defaults to `resolveTimeoutMs`.
     * An engram that exceeds it becomes a `timeout` failure; the others are
     * unaffected.
     */
    timeoutMs?: number;
}
export declare function federatedQuery(runner: FederatedQueryRunner, graphIds: GraphId[], query: string, cfg: PolicyConfig, budget?: SubgraphBudget, 
/**
 * Engrams the caller has explicitly authorised (e.g. an app-side per-engram
 * consent gate approved an explicitly-named sensitive engram). These bypass
 * the shareability filter so a consented sensitive recall actually returns
 * data — still clamped by the per-tier budget cap. Proactive recall passes
 * nothing here, so sensitive stays excluded by default.
 */
allowGraphIds?: GraphId[], opts?: FederatedQueryOptions): Promise<FederatedSubgraph>;
/**
 * Default per-engram allowance.
 *
 * THE CLOCK NECESSARILY STARTS AT DISPATCH, NOT WHEN THE WORK STARTS. The
 * `FederatedQueryRunner` contract is a bare `runQuery(...) => Promise`: the host
 * is free to queue internally (the desktop sidecar serialises every per-graph
 * call through one chain, because ONNX is not safe under concurrent
 * invocation), and federation has no way to observe when a call leaves that
 * queue. Timing an engram from dispatch therefore charges it for the queue
 * ahead of it — so a flat timeout would start killing HEALTHY engrams exactly
 * when several recalls overlap, converting a robustness fix into a new failure
 * mode. Observing the true start would need a contract change (a `started`
 * callback, or the AbortSignal noted in `withTimeout`); until then the default
 * absorbs the queue by growing with the number of engrams in scope: a 12-engram
 * recall allows 70s, of which any single engram would normally use well under a
 * second. This is a backstop against "never", not a latency target.
 */
export declare function resolveTimeoutMs(graphCount: number): number;
/**
 * 32-bit DJB2 over the normalized content, hex-encoded.
 *
 * This is a BUCKET KEY, never an identity. 32 bits collide at corpus scale
 * (birthday bound: ~25% odds by 50k distinct memories), and dropping a node on
 * a bare hash match is how the SDK silently deleted a DIFFERENT memory that
 * happened to collide. Every caller here re-checks the normalized content
 * inside the bucket before dropping anything — a hash match with different
 * content is a collision, and both nodes are kept.
 *
 * Exported so tests can pin the collision behaviour against a real collision.
 */
export declare function contentFingerprint(text: string): string;
export { TIER_CAPS };
//# sourceMappingURL=index.d.ts.map