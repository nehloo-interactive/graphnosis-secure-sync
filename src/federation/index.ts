import type { GraphId, SubgraphBudget } from '../types.js';
import {
  DEFAULT_BUDGET,
  TIER_CAPS,
  budgetFor,
  estimateTokens,
  redactNode,
  shareableGraphs,
  tierOf,
  withholdReason,
  type PolicyConfig,
  type SensitivityTier,
  type WithheldReason,
} from '../policy/index.js';

// Federation = run query against every graph the user owns, merge results into one budgeted context.
// The sidecar binds `runQuery` to Graphnosis' `query()` per graph.
//
// Budget enforcement happens in two layers:
//   1. Per-graph tier cap (sensitive < deidentified < public) — applied BEFORE selection.
//   2. Global request budget — applied DURING selection across all graphs.
// A request asking for 5000 tokens / 50 nodes against a `sensitive` graph
// still gets ≤ 500 tokens / 5 nodes from that graph.
//
// Between the two layers sits content deduplication: the same memory living in
// two engrams (a note synced or copied between them) must not be paid for twice
// out of one budget, or it displaces distinct evidence. See `dedupeByContent`.
//
// Per-graph failures DEGRADE rather than abort — one unreachable engram must not
// cost the user every other engram's answer — but they are never silent. The
// result is a DISCRIMINATED UNION on `complete`, so incompleteness is a
// compile-time obligation rather than a field a caller may forget to read:
// nothing can reach the model without the caller first narrowing on `complete`.
// See `FederatedSubgraph`.
//
// An engram that HANGS is handled the same way as one that fails: every runner
// call races a per-graph timeout. See `resolveTimeoutMs`.

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
export function federationFailures(sub: FederatedSubgraph): GraphFailure[] {
  return sub.complete ? [] : sub.failures;
}

export interface FederatedQueryOptions {
  /**
   * Per-engram wall-clock allowance. Defaults to `resolveTimeoutMs`.
   * An engram that exceeds it becomes a `timeout` failure; the others are
   * unaffected.
   */
  timeoutMs?: number;
}

export async function federatedQuery(
  runner: FederatedQueryRunner,
  graphIds: GraphId[],
  query: string,
  cfg: PolicyConfig,
  budget: SubgraphBudget = DEFAULT_BUDGET,
  /**
   * Engrams the caller has explicitly authorised (e.g. an app-side per-engram
   * consent gate approved an explicitly-named sensitive engram). These bypass
   * the shareability filter so a consented sensitive recall actually returns
   * data — still clamped by the per-tier budget cap. Proactive recall passes
   * nothing here, so sensitive stays excluded by default.
   */
  allowGraphIds?: GraphId[],
  opts?: FederatedQueryOptions,
): Promise<FederatedSubgraph> {
  const shareable = shareableGraphs(cfg, graphIds, allowGraphIds);
  const perGraphK = Math.max(5, Math.ceil(budget.maxNodes / Math.max(1, shareable.length)) * 2);
  const timeoutMs = opts?.timeoutMs ?? resolveTimeoutMs(shareable.length);

  // Run all per-graph queries in parallel, tolerating per-graph failure.
  // `Promise.all` here meant one slow or broken engram rejected the whole
  // federated recall and the user got nothing — every healthy engram's answer
  // thrown away because of one sibling. `allSettled` degrades per graph instead
  // (and stays `allSettled` rather than `Promise.all` over a try//catch mapper,
  // so the batch cannot be made abortable again by a later edit to the mapper).
  // The failures are NOT swallowed: each becomes a `status: 'failed'` audit row
  // AND a `GraphFailure` on the `complete: false` branch of the return type.
  const settled = await Promise.allSettled(
    shareable.map(async (g): Promise<[GraphId, CandidateNode[]]> => [
      g,
      await withTimeout(runner.runQuery(g, query, perGraphK), timeoutMs),
    ]),
  );

  const results: Array<[GraphId, CandidateNode[]]> = [];
  const failures = new Map<GraphId, { reason: 'error' | 'timeout'; error: string }>();
  for (let i = 0; i < settled.length; i++) {
    const g = shareable[i];
    const outcome = settled[i];
    if (g === undefined || outcome === undefined) continue;
    if (outcome.status === 'fulfilled') {
      results.push(outcome.value);
    } else {
      failures.set(g, {
        reason: outcome.reason instanceof GraphQueryTimeout ? 'timeout' : 'error',
        error: describeError(outcome.reason),
      });
    }
  }

  // Layer 1: per-graph tier cap. Compute it once per graph; track running usage.
  const graphCaps = new Map<GraphId, { maxTokens: number; maxNodes: number; usedTokens: number; usedNodes: number }>();
  for (const g of shareable) {
    const cap = budgetFor(cfg, g, budget);
    graphCaps.set(g, { ...cap, usedTokens: 0, usedNodes: 0 });
  }

  // Apply per-graph policy filters (redaction).
  const filtered: CandidateNode[] = [];
  for (const [g, candidates] of results) {
    const policy = cfg.graphs.find(p => p.graphId === g);
    for (const c of candidates) {
      const probe: { type?: string; tags?: string[]; content?: string } = { content: c.text };
      if (c.type !== undefined) probe.type = c.type;
      if (c.tags !== undefined) probe.tags = c.tags;
      if (redactNode(probe, policy)) continue;
      filtered.push(c);
    }
  }

  // Interleave across graphs by score, respecting both tier caps and the global budget.
  // Deterministic tie-breaker: when two candidates score identically (very common
  // under entity anchoring's ANCHOR_SCORE constant, where every literal-entity
  // match collapses to the same score), fall back to graphId then nodeId
  // lexicographic order. Without this, ties are broken by the order the
  // per-graph queries settle in — which depends on I/O timing and produces
  // non-deterministic "top result" placements across otherwise-identical
  // recall calls. (Still true under `allSettled`: it preserves input order in
  // its result array, but the underlying queries finish whenever they finish.)
  filtered.sort((a, b) =>
    (b.score - a.score) ||
    a.graphId.localeCompare(b.graphId) ||
    a.nodeId.localeCompare(b.nodeId),
  );

  // Collapse duplicated content BEFORE budgeting, so the budget buys distinct
  // evidence. Runs on the sorted array, so the surviving copy is picked
  // deterministically (see `dedupeByContent`).
  const { kept: deduped, droppedByGraph } = dedupeByContent(filtered, cfg);

  const byGraph = new Map<GraphId, CandidateNode[]>();
  let totalTokens = 0;
  let totalCount = 0;
  const minPerGraph = budget.perGraphMinTokens ?? 0;
  const reserved = new Map<GraphId, number>();
  for (const g of shareable) reserved.set(g, minPerGraph);

  for (const cand of deduped) {
    if (totalCount >= budget.maxNodes) break;
    const t = estimateTokens(cand.text);
    const cap = graphCaps.get(cand.graphId);
    if (!cap) continue;

    // Per-graph tier cap is hard.
    if (cap.usedNodes >= cap.maxNodes) continue;
    if (cap.usedTokens + t > cap.maxTokens) continue;

    // Global budget allows a reserved minimum per graph; otherwise yields to the budget.
    const reservedHere = reserved.get(cand.graphId) ?? 0;
    if (totalTokens + t > budget.maxTokens && reservedHere <= 0) continue;

    const bucket = byGraph.get(cand.graphId) ?? [];
    bucket.push(cand);
    byGraph.set(cand.graphId, bucket);

    cap.usedTokens += t;
    cap.usedNodes += 1;
    totalTokens += t;
    totalCount += 1;
    if (reservedHere > 0) reserved.set(cand.graphId, Math.max(0, reservedHere - t));
  }

  // One row per REQUESTED engram — the queried ones in `audit`, the ones policy
  // kept out in `withheld`. An engram that was withheld is a result, not an
  // absence, but it is deliberately NOT in the array callers count: see
  // `WithheldGraphAudit`.
  const inScope = new Set(shareable);
  const audit: QueriedGraphAudit[] = [];
  const withheld: WithheldGraphAudit[] = [];
  const failureList: GraphFailure[] = [];
  for (const g of graphIds) {
    const tier = tierOf(cfg, g);
    if (!inScope.has(g)) {
      // `withholdReason` is the same function `shouldShare` is defined in terms
      // of, so this row cannot claim a different reason than the filter used.
      // It is only ever undefined if the graph was dropped for some reason
      // other than policy, which cannot happen today; fall back to the stricter
      // of the two rather than inventing a third status.
      withheld.push({ graphId: g, tier, status: 'withheld', reason: withholdReason(cfg, g) ?? 'sharing-disabled' });
      continue;
    }
    const cap = graphCaps.get(g)!;
    const failure = failures.get(g);
    if (failure !== undefined) {
      // No counts on this row, by construction — see `FailedGraphAudit`.
      audit.push({ graphId: g, tier, status: 'failed', error: failure.error });
      failureList.push({ graphId: g, tier, reason: failure.reason, error: failure.error });
      continue;
    }
    audit.push({
      graphId: g,
      tier,
      status: 'ok',
      nodesIncluded: cap.usedNodes,
      tokensIncluded: cap.usedTokens,
      duplicatesDropped: droppedByGraph.get(g) ?? 0,
    });
  }

  const base: FederatedSubgraphBase = { byGraph, tokensUsed: totalTokens, nodesIncluded: totalCount, audit, withheld };
  if (failureList.length === 0) {
    return { ...base, complete: true, prompt: renderPrompt(byGraph, audit) };
  }
  return { ...base, complete: false, failures: failureList, partialPrompt: renderPrompt(byGraph, audit) };
}

function describeError(reason: unknown): string {
  if (reason instanceof Error) return reason.message || reason.name;
  return String(reason);
}

// --- Per-graph timeout -------------------------------------------------------

/**
 * Base allowance for reading one engram: a cold ONNX/embedding init, decrypt,
 * and the query itself.
 */
const TIMEOUT_BASE_MS = 15_000;
/**
 * Added per ADDITIONAL engram in scope. See `resolveTimeoutMs` for why the
 * default has to grow with the size of the request.
 */
const TIMEOUT_PER_QUEUED_GRAPH_MS = 5_000;

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
export function resolveTimeoutMs(graphCount: number): number {
  return TIMEOUT_BASE_MS + TIMEOUT_PER_QUEUED_GRAPH_MS * Math.max(0, graphCount - 1);
}

class GraphQueryTimeout extends Error {
  constructor(ms: number) {
    super(`timed out after ${ms}ms`);
    this.name = 'GraphQueryTimeout';
  }
}

/**
 * Reject with `GraphQueryTimeout` if `work` has not settled within `ms`.
 *
 * `allSettled` fixes the engram that FAILS; it does nothing for the engram that
 * HANGS — a stalled network mount, a lock held forever. That promise never
 * settles, so without this the whole recall waits indefinitely: no error, no
 * result, no end, which is worse for a user than a failure.
 *
 * KNOWN LIMITATION — THIS IS TIMEOUT-AND-IGNORE, NOT CANCELLATION. The
 * abandoned `work` promise keeps running, holding whatever the host allocated
 * for it (a file handle, a read transaction, an ONNX slot) until it settles on
 * its own, if it ever does. Stopping the read for real needs an AbortSignal
 * threaded through `FederatedQueryRunner.runQuery`, i.e. a change to the runner
 * contract and to every host that implements it — a deliberate decision, left
 * to a later change rather than smuggled in here. A late rejection from the
 * abandoned promise is absorbed by the race and cannot surface as an unhandled
 * rejection.
 */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const alarm = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new GraphQueryTimeout(ms)), ms);
  });
  return Promise.race([work, alarm]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

// --- Content deduplication ---------------------------------------------------

/** Whitespace-only differences are not different memories; anything else is. */
function normalizeContent(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

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
export function contentFingerprint(text: string): string {
  const norm = normalizeContent(text);
  let h = 5381;
  for (let i = 0; i < norm.length; i++) h = (((h << 5) + h) + norm.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

const TIER_RANK: Record<SensitivityTier, number> = { public: 0, deidentified: 1, sensitive: 2 };

/**
 * Collapse candidates whose content is identical, keeping exactly one copy.
 *
 * Must run BEFORE budget allocation: the same note synced into two engrams
 * otherwise pays twice out of one token budget and displaces distinct evidence.
 *
 * WHICH COPY SURVIVES IS DETERMINISTIC — the input is already sorted by
 * (score desc, graphId, nodeId), and the only re-ordering rule applied on top
 * is tier rank, which is a pure function of the policy config:
 *   1. Lowest sensitivity tier wins. Identical content available from a public
 *      engram must not be charged to the `sensitive` engram's 500-token / 5-node
 *      cap — that would spend the scarcest budget in the system on evidence that
 *      was free elsewhere, and re-attribute the memory to the sensitive engram
 *      in the rendered prompt.
 *   2. Otherwise the earlier entry in the sorted order wins, i.e. higher score,
 *      then graphId, then nodeId.
 * Nothing here depends on which engram's promise settled first, so the same
 * inputs always yield the same survivor.
 */
function dedupeByContent(
  candidates: CandidateNode[],
  cfg: PolicyConfig,
): { kept: CandidateNode[]; droppedByGraph: Map<GraphId, number> } {
  type Group = { norm: string; best: CandidateNode };
  const buckets = new Map<string, Group[]>();
  const droppedByGraph = new Map<GraphId, number>();
  const drop = (g: GraphId) => droppedByGraph.set(g, (droppedByGraph.get(g) ?? 0) + 1);

  for (const cand of candidates) {
    const norm = normalizeContent(cand.text);
    const fp = contentFingerprint(cand.text);
    const bucket = buckets.get(fp);
    if (bucket === undefined) {
      buckets.set(fp, [{ norm, best: cand }]);
      continue;
    }
    // Verify the CONTENT, not just the hash. A hash hit with different content
    // is a collision between two genuinely different memories: keep both.
    const group = bucket.find(g => g.norm === norm);
    if (group === undefined) {
      bucket.push({ norm, best: cand });
      continue;
    }
    if (TIER_RANK[tierOf(cfg, cand.graphId)] < TIER_RANK[tierOf(cfg, group.best.graphId)]) {
      drop(group.best.graphId);
      group.best = cand;
    } else {
      drop(cand.graphId);
    }
  }

  const survivors = new Set<CandidateNode>();
  for (const bucket of buckets.values()) for (const group of bucket) survivors.add(group.best);

  const kept: CandidateNode[] = [];
  const emitted = new Set<CandidateNode>();
  for (const cand of candidates) {
    if (!survivors.has(cand) || emitted.has(cand)) continue;
    emitted.add(cand);
    kept.push(cand);
  }
  return { kept, droppedByGraph };
}

function renderPrompt(byGraph: Map<GraphId, CandidateNode[]>, audit: QueriedGraphAudit[]): string {
  const sections: string[] = [];
  sections.push('# Graphnosis context');
  sections.push('The following memories from the user\'s personal graphs may be relevant.');
  // Tell the model the evidence is incomplete when it is. Without this an
  // unreadable engram reads downstream as an engram with nothing to say, and
  // the model asserts an absence it never verified.
  //
  // A WITHHELD engram cannot be named here even by accident: withheld rows are
  // not in `audit` at all. That is structural rather than a filter to get right
  // — the banner is model-facing text, and naming "clinic-records was withheld"
  // would disclose to the AI both that a sensitive engram exists and that it
  // was relevant enough to be in scope. Withholding that leaks the withholding
  // is not withholding. Withheld rows go to the caller on `sub.withheld`, which
  // is user-facing, not to the model.
  const failed = audit.filter(a => a.status === 'failed');
  if (failed.length > 0) {
    sections.push(
      `\n> INCOMPLETE CONTEXT: ${failed.length} engram(s) could not be queried ` +
      `(${failed.map(f => f.graphId).join(', ')}). Absence of a memory below is NOT evidence it does not exist.`,
    );
  }
  for (const [g, items] of byGraph) {
    sections.push(`\n## Graph: ${g}`);
    for (const item of items) {
      sections.push(`- ${item.text}`);
    }
  }
  return sections.join('\n');
}

export { TIER_CAPS };
