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

// Absolute ceiling on live (session, run) slots. TTL prunes idle turns, but a
// burst of many short-lived runs inside one TTL window could grow the map
// without bound. This LRU cap evicts the oldest-touched slot once the ceiling is
// crossed, so the map stays bounded even if nothing expires. Sized far above any
// realistic concurrent-turn count, so it only trips on runaway growth.
export const MAX_TURN_SEND_SLOTS = 2048;

type TurnSendSlot = {
  // Sends that have landed this turn, per target. Admission compares committed +
  // pending against the cap; peek and the nudge read this committed count.
  committed: Map<string, number>;
  // In-flight reservations per target: a send that has been admitted but whose
  // delivery has not settled yet. Held separately from committed so a concurrent
  // same-target send counts toward the cap during the in-flight window (blocking
  // toward it, never past it) and so a rolled-back reservation leaves committed
  // untouched.
  pending: Map<string, number>;
  // Operation identities already committed this turn. conversations_send derives a
  // stable operationId per (toolCallId, conversationRef); the Gateway resolves a
  // repeated one to the completed operation and returns "sent" without
  // re-delivering. Tracking committed ids lets a replay through the cap and keeps
  // it from double-counting. The message tool passes its idempotency key here too.
  seenOperations: Set<string>;
  recordedAt: number;
};

// One entry per (session, run): the turn's per-target committed counts and pending
// reservations. Concurrent turns can share a sessionKey but carry distinct runIds, so
// runId is folded into the key — keying by sessionKey alone would let a later run's
// reserve/commit evict an earlier still-live run's counts.
const turnSendBySession = new Map<string, TurnSendSlot>();

// The map key `${sessionKey}\0${runId}`. The NUL separator can't appear in either
// component, so distinct (session, run) pairs never collide.
function ledgerKey(sessionKey: string, runId: string): string {
  return `${sessionKey}\0${runId}`;
}

// Reseat a slot as the most-recently-used entry (delete + set moves it to the
// Map's tail) and evict the oldest slots past the cap. Map iteration order is
// insertion order, so the first key is the least-recently-touched slot. Every
// reserve/commit/release touch reseats its slot, so eviction order is LRU by write access.
function storeSlot(key: string, slot: TurnSendSlot): void {
  turnSendBySession.delete(key);
  turnSendBySession.set(key, slot);
  while (turnSendBySession.size > MAX_TURN_SEND_SLOTS) {
    const oldest = turnSendBySession.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    turnSendBySession.delete(oldest);
  }
}

type TurnSendKey = {
  sessionKey: string;
  runId: string;
  targetKey: string;
};

/**
 * Canonical per-turn ledger *session* slot key `${agentId}\0${sessionKey}`, shared by
 * the `message` and `conversations_send` tools. Both must scope the ledger by the same
 * agent-prefixed session so alternating the two tools at one recipient can't evade the
 * nudge or the hard cap; keying by the raw session key on one tool and the agent-prefixed
 * key on the other (the #119992 drift) split one turn across two slots.
 *
 * The NUL join and fallback mirror the message tool's original inline construction exactly
 * (message-tool-execution.ts): the session key is trimmed, and when either the agent id or
 * the trimmed session key is absent the caller has no ledger scope, so this returns
 * undefined and the budget stays inert for that call.
 */
export function buildTurnSendLedgerSessionKey(
  agentId: string | undefined,
  sessionKey: string | undefined,
): string | undefined {
  const trimmedSessionKey = sessionKey?.trim() || undefined;
  if (!trimmedSessionKey || !agentId) {
    return undefined;
  }
  return `${agentId}\0${trimmedSessionKey}`;
}

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

// A slot is live only within the TTL window measured from its last write. Peek,
// reserve, commit, and release share this predicate so they agree on what "expired"
// means: peek returns 0 for an expired slot (dropping it), while reserve/commit start
// a fresh turn for one. Deliberate tradeoff: a >10-min-idle gap within a single turn
// resets that turn's budget. Accepted because the cap is a best-effort runaway-fan-out
// backstop, not a strict guarantee (see the module header).
function isLiveSlot(slot: TurnSendSlot, now: number): boolean {
  return now - slot.recordedAt <= TURN_SEND_LEDGER_TTL_MS;
}

// The (session, run) slot, or a fresh one when that pair has no entry or its TTL
// window has elapsed. A different run on the same session is a distinct key, so it
// naturally gets its own fresh slot instead of evicting this one. Shared by reserve
// and commit so committed counts, pending reservations, and seen-operation ids reset
// together on a turn boundary. Callers mutate the returned slot and reseat it via the map.
function liveSlotForTurn(sessionKey: string, runId: string, now: number): TurnSendSlot {
  const existing = turnSendBySession.get(ledgerKey(sessionKey, runId));
  if (existing && isLiveSlot(existing, now)) {
    return existing;
  }
  return {
    committed: new Map<string, number>(),
    pending: new Map<string, number>(),
    seenOperations: new Set<string>(),
    recordedAt: now,
  };
}

type ReservationState = "reserved" | "committed" | "released";

/**
 * Handle returned by a successful reserveTurnSend. Opaque to callers: they hold it
 * across the awaited delivery, then settle it exactly once — commitTurnSend when the
 * send landed, releaseTurnSend when it did not. The mutable `state` makes a second
 * settle a no-op, so a double commit/release or a commit-after-release cannot corrupt
 * the counts.
 */
export type TurnSendReservation = {
  readonly key: TurnSendKey;
  readonly operationId: string | undefined;
  state: ReservationState;
};

export type TurnSendReserveResult =
  | { status: "reserved"; reservation: TurnSendReservation }
  | { status: "exhausted" }
  | { status: "replay" };

/**
 * Reserves one send to `targetKey` for the current turn before delivery is attempted,
 * so a concurrent same-target send cannot slip past a positive cap while the first is
 * still in flight (the peek→await→record window used to admit both). Admission compares
 * committed + already-pending against `maxPerTurn`:
 *
 *   - `replay`    — `operationId` was already committed this turn (an idempotent Gateway
 *                   replay). Admitted past the cap and NOT recounted; the caller
 *                   dispatches but must skip settling.
 *   - `exhausted` — committed + pending has reached a positive `maxPerTurn`. The caller
 *                   suppresses the send.
 *   - `reserved`  — otherwise; pending is incremented and the returned reservation must
 *                   be settled once via commitTurnSend or releaseTurnSend.
 *
 * The reservation is pessimistic for the in-flight window: it blocks toward the cap the
 * instant it is taken and never past it. That is a deliberate best-effort backstop
 * against runaway fan-out, not strict serialization — a released reservation frees the
 * slot again, and the cap is not a hard delivery guarantee (see the module header).
 *
 * With `maxPerTurn` undefined (media / no configured cap) admission never returns
 * `exhausted`, yet pending/committed are still tracked so the soft nudge keeps counting.
 * `now` is injectable for deterministic tests; it defaults to the wall clock.
 */
export function reserveTurnSend(
  key: TurnSendKey,
  options: { maxPerTurn?: number; operationId?: string },
  now: number = Date.now(),
): TurnSendReserveResult {
  pruneExpired(now);
  const storeKey = ledgerKey(key.sessionKey, key.runId);
  const slot = liveSlotForTurn(key.sessionKey, key.runId, now);
  if (options.operationId !== undefined && slot.seenOperations.has(options.operationId)) {
    slot.recordedAt = now;
    storeSlot(storeKey, slot);
    return { status: "replay" };
  }
  const committed = slot.committed.get(key.targetKey) ?? 0;
  const pending = slot.pending.get(key.targetKey) ?? 0;
  // committed + pending, never committed alone: an in-flight reservation must count
  // toward the cap or two racing sends both admit before either commits.
  if (options.maxPerTurn !== undefined && committed + pending >= options.maxPerTurn) {
    return { status: "exhausted" };
  }
  slot.pending.set(key.targetKey, pending + 1);
  slot.recordedAt = now;
  storeSlot(storeKey, slot);
  return {
    status: "reserved",
    reservation: { key, operationId: options.operationId, state: "reserved" },
  };
}

/**
 * Settles a reservation whose delivery landed: moves it from pending to committed,
 * records its operationId so an idempotent replay is admitted past the cap without
 * recounting, refreshes the turn TTL, and returns the resulting committed send count
 * for the target (>= 2 means the caller should nudge). Idempotent: a repeat call — or a
 * commit after release — neither re-increments committed nor re-decrements pending and
 * simply reports the current committed count. `now` is injectable for tests.
 */
export function commitTurnSend(reservation: TurnSendReservation, now: number = Date.now()): number {
  const { sessionKey, runId, targetKey } = reservation.key;
  pruneExpired(now);
  const storeKey = ledgerKey(sessionKey, runId);
  const slot = liveSlotForTurn(sessionKey, runId, now);
  if (reservation.state !== "reserved") {
    slot.recordedAt = now;
    storeSlot(storeKey, slot);
    return slot.committed.get(targetKey) ?? 0;
  }
  reservation.state = "committed";
  releasePending(slot, targetKey);
  const committed = (slot.committed.get(targetKey) ?? 0) + 1;
  slot.committed.set(targetKey, committed);
  if (reservation.operationId !== undefined) {
    slot.seenOperations.add(reservation.operationId);
  }
  slot.recordedAt = now;
  storeSlot(storeKey, slot);
  return committed;
}

/**
 * Rolls back a reservation whose delivery never reached the peer (suppressed, dry-run,
 * broadcast, or a throw): decrements only the pending count, leaving committed and the
 * seen-operation set untouched, so a failed send neither consumes the cap nor fires a
 * nudge. Idempotent and double-release safe via the reservation `state`; a no-op once
 * the reservation is committed or the turn's slot has already expired. `now` is
 * injectable for tests.
 */
export function releaseTurnSend(reservation: TurnSendReservation, now: number = Date.now()): void {
  if (reservation.state !== "reserved") {
    return;
  }
  reservation.state = "released";
  const { sessionKey, runId, targetKey } = reservation.key;
  const storeKey = ledgerKey(sessionKey, runId);
  const slot = turnSendBySession.get(storeKey);
  if (!slot || !isLiveSlot(slot, now)) {
    return;
  }
  releasePending(slot, targetKey);
  slot.recordedAt = now;
  storeSlot(storeKey, slot);
}

// Decrement one pending reservation for `targetKey`, dropping the map entry at zero so
// the pending map only holds targets with live in-flight sends. Clamped at zero: a slot
// recreated after TTL expiry has no pending to remove, and a reservation must never
// drive the count negative.
function releasePending(slot: TurnSendSlot, targetKey: string): void {
  const pending = slot.pending.get(targetKey) ?? 0;
  if (pending > 1) {
    slot.pending.set(targetKey, pending - 1);
  } else {
    slot.pending.delete(targetKey);
  }
}

/**
 * Reads the current turn's committed send count for `targetKey` without mutating the
 * ledger — read-only inspection (production settles through reserve/commit; tests use
 * this to assert the committed total). Returns 0 when the (session, run) pair has no
 * entry, or the target has not been committed to yet. `now` is injectable for tests.
 *
 * An expired slot is pruned and treated as 0: otherwise a capped slot past its TTL
 * would keep returning its stale count. Deleting the one slot on peek is safe under
 * single-threaded JS.
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
  return slot.committed.get(targetKey) ?? 0;
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
