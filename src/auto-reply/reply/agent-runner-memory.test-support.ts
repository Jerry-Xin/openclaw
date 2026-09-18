// Memory-flush plan fixtures shared with agent-runner-memory.test.ts, split out to keep
// that grandfathered test file within its line cap.
import type { MemoryFlushPlan } from "../../plugins/memory-state.test-fixtures.js";

export function createMemoryFlushPlan(): MemoryFlushPlan {
  return {
    softThresholdTokens: 4_000,
    forceFlushTranscriptBytes: 1_000_000_000,
    reserveTokensFloor: 20_000,
    prompt: "Pre-compaction memory flush.\nNO_REPLY",
    systemPrompt: "Write memory to memory/YYYY-MM-DD.md.",
    relativePath: "memory/2023-11-14.md",
  };
}

export function createModifiedMemoryFlushPlan(
  overrides: Partial<MemoryFlushPlan>,
): MemoryFlushPlan {
  return { ...createMemoryFlushPlan(), ...overrides };
}
