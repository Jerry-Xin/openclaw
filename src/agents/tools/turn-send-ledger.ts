/**
 * Per-turn, per-target outbound send ledger shared by the `message` and
 * `conversations_send` tools.
 *
 * The loop detector hashes full tool params (tool-loop-detection.ts), so a model
 * that re-sends the same answer with slightly reworded text produces a distinct
 * hash every time and is invisible to it. This ledger counts *successful*
 * deliveries per (turn, target) so a tool can nudge the model — or, when an
 * operator opts in, cap the fan-out — independently of the loop detector and its
 * default-off switch.
 *
 * State is module-level and keyed by (agent session, run), mirroring the reviewed
 * `recentPollVoteBySession` precedent in message-tool.ts: a per-tool-instance
 * counter would be lost across the run boundary that separates the tool calls in
 * one turn, so the count must outlive the instance. A "turn" is one agent run
 * (`runId`), so each entry is scoped to one (session, run) pair; a run that has no
 * entry starts fresh, which bounds the counts to a single turn without any
 * explicit cleanup. Concurrent foreground runs can share one sessionKey (see
 * src/auto-reply/dispatch.freshness.test.ts), so the runId is part of the key
 * rather than a field that resets a shared slot — otherwise a later run would
 * evict an earlier still-live run's counts.
 */
import { normalizeTargetForProvider } from "../../infra/outbound/target-normalization.js";
import { normalizeAccountId } from "../../routing/account-id.js";
import { normalizeMessageChannel } from "../../utils/message-channel-normalize.js";

// A turn can span more tool round-trips than a poll echo, so this TTL is longer
// than POLL_VOTE_ECHO_TTL_MS; it only prunes (session, run) entries that went fully
// idle and keeps the map bounded in a long-lived gateway.
export const TURN_SEND_LEDGER_TTL_MS = 10 * 60_000;

type TurnSendSlot = {
  counts: Map<string, number>;
  // Operation identities already counted this turn. conversations_send derives a
  // stable operationId per (toolCallId, conversationRef); the Gateway resolves a
  // repeated one to the completed operation and returns "sent" without
  // re-delivering. Tracking seen ids lets a replay through the cap and keeps it
  // from double-counting. The message tool has no operationId and never touches this.
  seenOperations: Set<string>;
  recordedAt: number;
};

// One entry per (session, run): the turn's per-target counts. Concurrent turns can
// share a sessionKey but carry distinct runIds, so runId is folded into the key —
// keying by sessionKey alone would let a later run's record() evict an earlier
// still-live run's counts.
const turnSendBySession = new Map<string, TurnSendSlot>();

// The map key `${sessionKey}\0${runId}`. The NUL separator can't appear in either
// component, so distinct (session, run) pairs never collide.
function ledgerKey(sessionKey: string, runId: string): string {
  return `${sessionKey}\0${runId}`;
}

type TurnSendKey = {
  sessionKey: string;
  runId: string;
  targetKey: string;
};

/**
 * Canonical per-turn ledger key `${channel}\0${account}\0${target}`, shared by the
 * `message` and `conversations_send` tools. Both must key on the same normalized
 * route so alternating the two tools at one real recipient can't evade the nudge or
 * the hard cap. Byte-identical to the route `resolveOutboundActionRoute` builds in
 * message-tool.ts (`normalizeAccountId(undefined)` folds to the "default" account).
 */
export function buildTurnSendTargetKey(params: {
  channel: string;
  accountId?: string;
  target: string;
}): string {
  const channel = normalizeMessageChannel(params.channel);
  // Canonicalize the target the same way delivery does (case-fold, prefix strip,
  // phone normalization) so equivalent spellings of one peer ("TG:12345" vs
  // "12345") land in one ledger slot instead of bypassing the nudge/cap. This is
  // synchronous, idempotent, and provider-bound, so re-applying it to a route the
  // caller already canonicalized (conversations_send's record.target) is a no-op.
  // Out of scope by design: async directory-alias resolution (@username -> id) is
  // not resolved here; it stays off the cap hot path (accepted limitation).
  const target =
    normalizeTargetForProvider(channel ?? params.channel, params.target) ?? params.target;
  return `${channel}\0${normalizeAccountId(params.accountId)}\0${target}`;
}

// A slot is live only within the TTL window measured from its last write. Peek and
// record share this predicate so they agree on what "expired" means: peek returns 0
// for an expired slot (dropping it), while record starts a fresh turn for one.
// Deliberate tradeoff: a >10-min-idle gap within a single turn resets that turn's
// budget. Accepted because the cap is a best-effort runaway-fan-out backstop, not a
// strict guarantee (see the module header).
function isLiveSlot(slot: TurnSendSlot, now: number): boolean {
  return now - slot.recordedAt <= TURN_SEND_LEDGER_TTL_MS;
}

// The (session, run) slot, or a fresh one when that pair has no entry or its TTL
// window has elapsed. A different run on the same session is a distinct key, so it
// naturally gets its own fresh slot instead of evicting this one. Shared by every
// recorder so counts and seen-operation ids reset together on a turn boundary.
// Callers mutate the returned slot and reseat it via the map.
function liveSlotForTurn(sessionKey: string, runId: string, now: number): TurnSendSlot {
  const existing = turnSendBySession.get(ledgerKey(sessionKey, runId));
  if (existing && isLiveSlot(existing, now)) {
    return existing;
  }
  return {
    counts: new Map<string, number>(),
    seenOperations: new Set<string>(),
    recordedAt: now,
  };
}

/**
 * Records one successful send to `targetKey` in the current turn and returns the
 * running count (>= 1). A (session, run) pair with no live entry, or whose window
 * has expired, starts fresh before recording. `now` is injectable for deterministic
 * tests; it defaults to the wall clock.
 */
export function recordTurnSend(
  { sessionKey, runId, targetKey }: TurnSendKey,
  now: number = Date.now(),
): number {
  pruneExpired(now);
  const slot = liveSlotForTurn(sessionKey, runId, now);
  const next = (slot.counts.get(targetKey) ?? 0) + 1;
  slot.counts.set(targetKey, next);
  slot.recordedAt = now;
  turnSendBySession.set(ledgerKey(sessionKey, runId), slot);
  return next;
}

/**
 * Whether `operationId` has already been counted in the current live turn slot.
 * conversations_send checks this before the hard cap so an idempotent Gateway
 * replay (a repeated toolCallId resolved to the same completed operation without
 * re-delivery) is admitted instead of blocked. Returns false when the session has
 * no live slot for this turn. `now` is injectable for deterministic tests.
 */
export function hasRecordedTurnSendOperation(
  { sessionKey, runId }: TurnSendKey,
  operationId: string,
  now: number = Date.now(),
): boolean {
  const slot = turnSendBySession.get(ledgerKey(sessionKey, runId));
  if (!slot || !isLiveSlot(slot, now)) {
    return false;
  }
  return slot.seenOperations.has(operationId);
}

/**
 * Counts one successful send for `operationId` at most once per turn. The first
 * call for a given operationId increments the per-target count and returns it; a
 * repeated call for the same operationId (an idempotent Gateway replay) leaves the
 * count untouched and returns undefined, so a replay neither re-increments the
 * budget nor fires a second nudge. `now` is injectable for deterministic tests.
 */
export function recordTurnSendOnce(
  { sessionKey, runId, targetKey }: TurnSendKey,
  operationId: string,
  now: number = Date.now(),
): number | undefined {
  pruneExpired(now);
  const slot = liveSlotForTurn(sessionKey, runId, now);
  slot.recordedAt = now;
  turnSendBySession.set(ledgerKey(sessionKey, runId), slot);
  if (slot.seenOperations.has(operationId)) {
    return undefined;
  }
  slot.seenOperations.add(operationId);
  const next = (slot.counts.get(targetKey) ?? 0) + 1;
  slot.counts.set(targetKey, next);
  return next;
}

/**
 * Reads the current turn's send count for `targetKey` without incrementing it.
 * Returns 0 when the (session, run) pair has no entry, or the target has not been
 * sent to yet — so a caller can gate the next send before dispatch. `now` is
 * injectable for deterministic tests; it defaults to the wall clock.
 *
 * An expired slot is pruned and treated as 0: otherwise a capped slot past its TTL
 * would keep returning its stale count and block forever, since the cap check runs
 * before recordTurnSend (the only other pruner) ever gets to reset it. Deleting the
 * one slot on peek is safe under single-threaded JS.
 *
 * The cap this gates is best-effort, not a strict concurrency guarantee: callers
 * peek, await the actual delivery, then recordTurnSend after it lands, so the
 * peek→await→record window is not atomic. Two tool calls racing on the same
 * target can each peek below the cap before either records, so both admit one
 * send. This bounds runaway fan-out without serializing concurrent sends.
 */
export function peekTurnSendCount(
  { sessionKey, runId, targetKey }: TurnSendKey,
  now: number = Date.now(),
): number {
  const key = ledgerKey(sessionKey, runId);
  const slot = turnSendBySession.get(key);
  if (!slot) {
    return 0;
  }
  if (!isLiveSlot(slot, now)) {
    turnSendBySession.delete(key);
    return 0;
  }
  return slot.counts.get(targetKey) ?? 0;
}

export function resetTurnSendLedgerForTest(): void {
  turnSendBySession.clear();
}

function pruneExpired(now: number): void {
  for (const [key, slot] of turnSendBySession) {
    if (!isLiveSlot(slot, now)) {
      turnSendBySession.delete(key);
    }
  }
}
