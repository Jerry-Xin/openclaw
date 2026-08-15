import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildTurnSendLedgerSessionKey,
  buildTurnSendTargetKey,
  commitTurnSend,
  MAX_TURN_SEND_SLOTS,
  peekTurnSendCount,
  releaseTurnSend,
  reserveTurnSend,
  resetTurnSendLedgerForTest,
  TURN_SEND_LEDGER_TTL_MS,
  type TurnSendReservation,
  type TurnSendReserveResult,
} from "./turn-send-ledger.js";

// Stand-in for a provider target normalizer: case-fold and strip a leading "tg:"
// prefix, mirroring what a real telegram plugin normalizer does. Any other target
// (e.g. "reef:peer-agent") passes through unchanged, matching the real no-plugin
// fallback so the canonical-key test below stays valid.
vi.mock("../../infra/outbound/target-normalization.js", () => ({
  normalizeTargetForProvider: (_channel: string, raw?: string): string | undefined => {
    if (raw === undefined) {
      return undefined;
    }
    const trimmed = raw.trim();
    if (!trimmed) {
      return undefined;
    }
    const lowered = trimmed.toLowerCase();
    return lowered.startsWith("tg:") ? lowered.slice("tg:".length) : lowered;
  },
}));

type LedgerKey = { sessionKey: string; runId: string; targetKey: string };

// Assert a reserve succeeded and hand back the reservation, so a test that expected
// admission fails loudly at the reserve rather than at a later commit/release.
function expectReserved(result: TurnSendReserveResult): TurnSendReservation {
  if (result.status !== "reserved") {
    throw new Error(`expected a reserved reservation, got "${result.status}"`);
  }
  return result.reservation;
}

// The production reserve->await->settle round-trip collapsed for the counting tests:
// reserve, then immediately commit as if delivery landed. Returns the committed count.
// Passing `now` through both calls keeps the deterministic-clock tests injectable.
function commitOne(
  key: LedgerKey,
  options: { maxPerTurn?: number; operationId?: string } = {},
  now?: number,
): number {
  const reservation = expectReserved(reserveTurnSend(key, options, now));
  return commitTurnSend(reservation, now);
}

afterEach(() => {
  resetTurnSendLedgerForTest();
  vi.useRealTimers();
});

describe("turn-send-ledger", () => {
  it("counts committed sends per (runId, target) within one turn", () => {
    const base = { sessionKey: "s1", runId: "run-1", targetKey: "tg:a" };
    expect(commitOne(base)).toBe(1);
    expect(commitOne(base)).toBe(2);
    expect(commitOne(base)).toBe(3);
  });

  it("keeps separate committed counts per target inside the same turn", () => {
    expect(commitOne({ sessionKey: "s1", runId: "run-1", targetKey: "tg:a" })).toBe(1);
    expect(commitOne({ sessionKey: "s1", runId: "run-1", targetKey: "tg:b" })).toBe(1);
    expect(commitOne({ sessionKey: "s1", runId: "run-1", targetKey: "tg:a" })).toBe(2);
  });

  it("starts a fresh count for a new run on the same session", () => {
    expect(commitOne({ sessionKey: "s1", runId: "run-1", targetKey: "tg:a" })).toBe(1);
    expect(commitOne({ sessionKey: "s1", runId: "run-1", targetKey: "tg:a" })).toBe(2);
    // A new run on the same session is a distinct ledger key, so it starts fresh.
    expect(commitOne({ sessionKey: "s1", runId: "run-2", targetKey: "tg:a" })).toBe(1);
  });

  it("isolates counts across sessions", () => {
    expect(commitOne({ sessionKey: "s1", runId: "run-1", targetKey: "tg:a" })).toBe(1);
    expect(commitOne({ sessionKey: "s2", runId: "run-1", targetKey: "tg:a" })).toBe(1);
    expect(commitOne({ sessionKey: "s1", runId: "run-1", targetKey: "tg:a" })).toBe(2);
  });

  it("keeps interleaved runs on one session isolated (A -> B -> A)", () => {
    // Concurrent foreground turns share a sessionKey but carry distinct runIds:
    // src/auto-reply/dispatch.freshness.test.ts:703 ("keeps concurrent foreground
    // finals isolated for different targets sharing a session", sharedSessionKey
    // = "agent:main:main") starts run A, completes run B on the same session, then
    // resumes A. B committing between A's sends must not evict A's slot, or A's
    // cap/nudge silently resets to 0 mid-turn.
    const session = "agent:main:main";
    const target = "tg:a";
    const runA = { sessionKey: session, runId: "run-A", targetKey: target };
    const runB = { sessionKey: session, runId: "run-B", targetKey: target };
    expect(commitOne(runA)).toBe(1);
    expect(commitOne(runB)).toBe(1);
    expect(commitOne(runA)).toBe(2);
    expect(peekTurnSendCount(runA)).toBe(2);
    expect(peekTurnSendCount(runB)).toBe(1);
  });

  it("peeks the committed count without mutating and returns 0 for a different turn", () => {
    commitOne({ sessionKey: "s1", runId: "run-1", targetKey: "tg:a" });
    commitOne({ sessionKey: "s1", runId: "run-1", targetKey: "tg:a" });
    expect(peekTurnSendCount({ sessionKey: "s1", runId: "run-1", targetKey: "tg:a" })).toBe(2);
    // Peeking must not increment.
    expect(peekTurnSendCount({ sessionKey: "s1", runId: "run-1", targetKey: "tg:a" })).toBe(2);
    // A newer turn has no prior sends recorded.
    expect(peekTurnSendCount({ sessionKey: "s1", runId: "run-2", targetKey: "tg:a" })).toBe(0);
    // Unknown session/target reads as zero.
    expect(peekTurnSendCount({ sessionKey: "s9", runId: "run-1", targetKey: "tg:a" })).toBe(0);
  });

  it("does not surface an in-flight reservation as a committed count", () => {
    const key = { sessionKey: "s1", runId: "run-1", targetKey: "tg:a" };
    // A reservation is pending, not committed: peek reflects only landed sends.
    expectReserved(reserveTurnSend(key, {}));
    expect(peekTurnSendCount(key)).toBe(0);
  });

  it("prunes sessions idle past the TTL on write", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    commitOne({ sessionKey: "stale", runId: "run-1", targetKey: "tg:a" });
    // Advance beyond the TTL, then write for a different session so the prune runs.
    vi.setSystemTime(10 * 60_000 + 1);
    commitOne({ sessionKey: "fresh", runId: "run-1", targetKey: "tg:a" });
    // The stale session's slot is gone: its next write starts a fresh count.
    expect(peekTurnSendCount({ sessionKey: "stale", runId: "run-1", targetKey: "tg:a" })).toBe(0);
  });

  it("expires a capped slot on peek once past the TTL, unblocking a stuck turn", () => {
    const key = { sessionKey: "s1", runId: "run-1", targetKey: "tg:a" };
    // `now` is injected so the test needs no timers and stays deterministic.
    expect(commitOne(key, {}, 0)).toBe(1);
    expect(commitOne(key, {}, 0)).toBe(2);
    expect(peekTurnSendCount(key, 0)).toBe(2);
    // Past the TTL the capped slot would otherwise keep returning 2 and block forever,
    // since the cap check reserves before commit (the only other pruner) can reset it.
    expect(peekTurnSendCount(key, TURN_SEND_LEDGER_TTL_MS + 1)).toBe(0);
    // A commit after expiry restarts the turn's budget with the same runId.
    expect(commitOne(key, {}, TURN_SEND_LEDGER_TTL_MS + 2)).toBe(1);
  });

  it("builds the canonical channel/account/target key shared by both send tools", () => {
    // Byte-identical to resolveOutboundActionRoute in message-tool: an absent account
    // folds to "default" and the channel is normalized.
    expect(buildTurnSendTargetKey({ channel: "reef", target: "reef:peer-agent" })).toBe(
      "reef\u0000default\u0000reef:peer-agent",
    );
    expect(
      buildTurnSendTargetKey({ channel: "reef", accountId: "primary", target: "reef:peer-agent" }),
    ).toBe("reef\u0000primary\u0000reef:peer-agent");
  });

  it("canonicalizes the target so equivalent spellings share one ledger slot", () => {
    // Both spellings of one peer must produce a byte-identical key, otherwise
    // "TG:12345" and "12345" would occupy separate slots and bypass the nudge/cap.
    const prefixed = buildTurnSendTargetKey({ channel: "telegram", target: "TG:12345" });
    const bare = buildTurnSendTargetKey({ channel: "telegram", target: "12345" });
    expect(prefixed).toBe(bare);
    expect(prefixed).toBe("telegram\u0000default\u000012345");
  });
});

describe("turn-send-ledger session slot key", () => {
  it("builds the canonical agent-prefixed session slot key shared by both send tools", () => {
    // #119992: the message tool and conversations_send must scope the ledger by the
    // same `${agentId}\0${sessionKey}` slot. Keying one tool by the raw session key
    // and the other by this agent-prefixed key split one turn across two slots and let
    // alternating them evade the nudge/cap. A raw session key alone must not match.
    expect(buildTurnSendLedgerSessionKey("main", "agent:main:reef:direct:operator")).toBe(
      "main\u0000agent:main:reef:direct:operator",
    );
    expect(buildTurnSendLedgerSessionKey("main", "agent:main:reef:direct:operator")).not.toBe(
      "agent:main:reef:direct:operator",
    );
  });

  it("trims the session key and returns undefined when either component is absent", () => {
    // Fallback mirrors the message tool's original inline construction exactly: the
    // session key is trimmed, and a missing agent id or empty session key yields no
    // ledger scope (undefined), leaving the budget inert for that call.
    expect(buildTurnSendLedgerSessionKey("main", "  agent:main:main  ")).toBe(
      "main\u0000agent:main:main",
    );
    expect(buildTurnSendLedgerSessionKey(undefined, "agent:main:main")).toBeUndefined();
    expect(buildTurnSendLedgerSessionKey("main", undefined)).toBeUndefined();
    expect(buildTurnSendLedgerSessionKey("main", "   ")).toBeUndefined();
  });
});

describe("turn-send-ledger reservations", () => {
  const key = { sessionKey: "s1", runId: "run-1", targetKey: "tg:a" };

  it("counts a pending reservation toward a positive cap before it settles", () => {
    // Reserve one send at a cap of 1: admitted, but committed is still 0 (nothing
    // landed yet).
    expectReserved(reserveTurnSend(key, { maxPerTurn: 1, operationId: "op-1" }));
    expect(peekTurnSendCount(key)).toBe(0);
    // A second, distinct-op reserve BEFORE the first commits is exhausted — the
    // in-flight reservation already occupies the single cap slot. This is the race the
    // reserve/commit split closes: peek-then-record admitted both.
    expect(reserveTurnSend(key, { maxPerTurn: 1, operationId: "op-2" }).status).toBe("exhausted");
  });

  it("moves a committed reservation into the committed count and returns it", () => {
    const reservation = expectReserved(
      reserveTurnSend(key, { maxPerTurn: 2, operationId: "op-1" }),
    );
    expect(commitTurnSend(reservation)).toBe(1);
    // commit then peek === committed count.
    expect(peekTurnSendCount(key)).toBe(1);
  });

  it("admits an already-committed operationId past the cap as a replay", () => {
    const reservation = expectReserved(
      reserveTurnSend(key, { maxPerTurn: 1, operationId: "op-1" }),
    );
    expect(commitTurnSend(reservation)).toBe(1);
    // The same op again, with the cap reached, is a replay (idempotent Gateway retry),
    // not exhausted: it must be admitted so an already-earned receipt is not suppressed.
    expect(reserveTurnSend(key, { maxPerTurn: 1, operationId: "op-1" }).status).toBe("replay");
    // A genuinely distinct op at the cap is still exhausted.
    expect(reserveTurnSend(key, { maxPerTurn: 1, operationId: "op-2" }).status).toBe("exhausted");
  });

  it("rolls back a released reservation so the slot is free to reserve again", () => {
    const first = expectReserved(reserveTurnSend(key, { maxPerTurn: 1, operationId: "op-1" }));
    // While it is pending the cap is reached...
    expect(reserveTurnSend(key, { maxPerTurn: 1, operationId: "op-2" }).status).toBe("exhausted");
    releaseTurnSend(first);
    // ...but a rollback frees the slot for a fresh reservation.
    expect(reserveTurnSend(key, { maxPerTurn: 1, operationId: "op-2" }).status).toBe("reserved");
    // Release never touched committed: nothing landed.
    expect(peekTurnSendCount(key)).toBe(0);
  });

  it("is double-release safe and a release after commit does not decrement committed", () => {
    const reservation = expectReserved(
      reserveTurnSend(key, { maxPerTurn: 2, operationId: "op-1" }),
    );
    expect(commitTurnSend(reservation)).toBe(1);
    // Releasing an already-committed reservation, twice, must leave committed intact.
    releaseTurnSend(reservation);
    releaseTurnSend(reservation);
    expect(peekTurnSendCount(key)).toBe(1);
  });

  it("makes a repeat commit idempotent, reporting the committed count without double-counting", () => {
    const reservation = expectReserved(reserveTurnSend(key, {}));
    expect(commitTurnSend(reservation)).toBe(1);
    // A second commit neither re-increments nor throws.
    expect(commitTurnSend(reservation)).toBe(1);
    expect(peekTurnSendCount(key)).toBe(1);
  });

  it("never exhausts when maxPerTurn is undefined but still counts for the nudge", () => {
    // Media / no configured cap: admission is unconditional, yet counting continues so
    // the soft nudge still fires from the second send.
    expect(commitOne(key, {})).toBe(1);
    const second = reserveTurnSend(key, {});
    expect(second.status).toBe("reserved");
    expect(commitTurnSend(expectReserved(second))).toBe(2);
    expect(peekTurnSendCount(key)).toBe(2);
  });
});

describe("turn-send-ledger operation identity", () => {
  const key = { sessionKey: "s1", runId: "run-1", targetKey: "tg:a" };

  it("counts an operationId once and treats a replay as admitted without re-counting", () => {
    expect(commitOne(key, { operationId: "op-1" })).toBe(1);
    // The same operationId is now committed, so a re-reserve is a replay, not a fresh
    // reservation, and the per-target count stays at 1.
    expect(reserveTurnSend(key, { operationId: "op-1" }).status).toBe("replay");
    expect(peekTurnSendCount(key)).toBe(1);
  });

  it("increments per distinct operationId to the same target", () => {
    expect(commitOne(key, { operationId: "op-1" })).toBe(1);
    expect(commitOne(key, { operationId: "op-2" })).toBe(2);
    expect(peekTurnSendCount(key)).toBe(2);
  });

  it("resets seen operations when the runId changes (new turn)", () => {
    commitOne(key, { operationId: "op-1" });
    // A new turn has no memory of the prior operationId, so it reserves fresh (not a
    // replay) and counts from 1.
    const nextTurn = { ...key, runId: "run-2" };
    expect(reserveTurnSend(nextTurn, { operationId: "op-1" }).status).toBe("reserved");
    expect(commitOne(nextTurn, { operationId: "op-1" })).toBe(1);
  });

  it("keeps seen operation ids isolated across interleaved runs on one session", () => {
    const session = "agent:main:main";
    const target = "tg:a";
    const runA = { sessionKey: session, runId: "run-A", targetKey: target };
    const runB = { sessionKey: session, runId: "run-B", targetKey: target };
    expect(commitOne(runA, { operationId: "op-a" })).toBe(1);
    expect(commitOne(runB, { operationId: "op-b" })).toBe(1);
    // op-a already committed for run A -> a re-reserve is an idempotent replay.
    expect(reserveTurnSend(runA, { operationId: "op-a" }).status).toBe("replay");
  });

  it("forgets seen operations once the slot expires past the TTL", () => {
    expect(commitOne(key, { operationId: "op-1" }, 0)).toBe(1);
    // Past the TTL the slot is treated as gone, so the id reads as unseen: the reserve
    // is fresh, not a replay, and the next commit restarts the turn's budget.
    expect(reserveTurnSend(key, { operationId: "op-1" }, TURN_SEND_LEDGER_TTL_MS + 1).status).toBe(
      "reserved",
    );
    expect(commitOne(key, { operationId: "op-1" }, TURN_SEND_LEDGER_TTL_MS + 2)).toBe(1);
  });
});

describe("turn-send-ledger capacity cap", () => {
  // Distinct (session, run) slots that never expire at now=0, so eviction is
  // driven purely by the LRU capacity bound rather than the TTL.
  const slot = (i: number) => ({ sessionKey: "s1", runId: `run-${i}`, targetKey: "tg:a" });

  it("evicts the oldest-touched slot once past MAX_TURN_SEND_SLOTS", () => {
    for (let i = 0; i < MAX_TURN_SEND_SLOTS; i++) {
      expect(commitOne(slot(i), {}, 0)).toBe(1);
    }
    // Every slot survives while the map sits at the cap.
    expect(peekTurnSendCount(slot(0), 0)).toBe(1);
    expect(peekTurnSendCount(slot(MAX_TURN_SEND_SLOTS - 1), 0)).toBe(1);
    // The next distinct slot crosses the cap and evicts the oldest (run-0).
    expect(commitOne(slot(MAX_TURN_SEND_SLOTS), {}, 0)).toBe(1);
    expect(peekTurnSendCount(slot(0), 0)).toBe(0);
    // The second-oldest and the newest slot remain.
    expect(peekTurnSendCount(slot(1), 0)).toBe(1);
    expect(peekTurnSendCount(slot(MAX_TURN_SEND_SLOTS), 0)).toBe(1);
  });

  it("treats a re-touched slot as most-recently-used, sparing it from eviction", () => {
    for (let i = 0; i < MAX_TURN_SEND_SLOTS; i++) {
      commitOne(slot(i), {}, 0);
    }
    // Re-committing the oldest slot moves it to the tail; run-1 becomes the oldest.
    expect(commitOne(slot(0), {}, 0)).toBe(2);
    commitOne(slot(MAX_TURN_SEND_SLOTS), {}, 0);
    expect(peekTurnSendCount(slot(0), 0)).toBe(2);
    expect(peekTurnSendCount(slot(1), 0)).toBe(0);
  });

  it("keeps TTL expiry and overlapping-run isolation intact under the cap", () => {
    const session = "agent:main:main";
    const runA = { sessionKey: session, runId: "run-A", targetKey: "tg:a" };
    const runB = { sessionKey: session, runId: "run-B", targetKey: "tg:a" };
    // Interleaved runs on one session keep distinct composite keys, so the LRU
    // store must not collapse them into one slot.
    expect(commitOne(runA, {}, 0)).toBe(1);
    expect(commitOne(runB, {}, 0)).toBe(1);
    expect(commitOne(runA, {}, 0)).toBe(2);
    expect(peekTurnSendCount(runA, 0)).toBe(2);
    expect(peekTurnSendCount(runB, 0)).toBe(1);
    // A write past the TTL still prunes the idle slots before storing the new one.
    commitOne(
      { sessionKey: "s2", runId: "fresh", targetKey: "tg:a" },
      {},
      TURN_SEND_LEDGER_TTL_MS + 1,
    );
    expect(peekTurnSendCount(runA, TURN_SEND_LEDGER_TTL_MS + 1)).toBe(0);
    expect(peekTurnSendCount(runB, TURN_SEND_LEDGER_TTL_MS + 1)).toBe(0);
  });
});
