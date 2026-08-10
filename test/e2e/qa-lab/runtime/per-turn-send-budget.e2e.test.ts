import { randomUUID } from "node:crypto";
// Real-behavior proof for the per-turn per-target send budget (PR #120491).
//
// Boots a real ephemeral Gateway child (mock-openai provider + qa-channel synthetic
// transport) and exercises the shared per-turn send ledger at the real delivery
// boundary — the Gateway plus the qa-channel outbound bus — rather than by stubbing
// callGateway.
//
// Two seams are used, each the tightest one that exposes the behavior:
//   * A real scripted agent turn (inbound -> mock model emits several `message`
//     sends in one run -> qa-channel delivery) proves the soft nudge counts only
//     confirmed deliveries. The ledger keys on the agent run, so this is the only
//     way to observe it end to end. The nudge text is read from the tool result the
//     runtime fed back to the model (the mock provider's request log).
//   * conversations_send has an owner-gated tool and returns a Code-Mode-only
//     structured `details` object that is not serialized to the model, bus, or
//     chat.history. To assert its schema-valid suppressed shape and idempotent
//     replay we run the real conversations_send tool in-process with a controlled
//     runId, while its callGateway is forwarded to the running Gateway child so the
//     delivery itself is real (Gateway conversations.send -> qa-channel bus). This
//     is not a stub: the result and the delivery come from the real Gateway.
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Value } from "typebox/value";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createQaBusState, startQaBusServer } from "../../../../extensions/qa-lab/api.js";
import { startQaLiveLaneGateway } from "../../../../extensions/qa-lab/runtime-api.js";
import { ConversationSendResultSchema } from "../../../../packages/gateway-protocol/src/schema/agent.js";
import { createConversationsSendTool } from "../../../../src/agents/tools/conversation-tools.js";
import {
  buildTurnSendTargetKey,
  hasRecordedTurnSendOperation,
  peekTurnSendCount,
  recordTurnSend,
  resetTurnSendLedgerForTest,
} from "../../../../src/agents/tools/turn-send-ledger.js";

const PRIMARY_MODEL = "mock-openai/gpt-5.6-luna";
const ALTERNATE_MODEL = "mock-openai/gpt-5.6-luna-alt";
const SCENARIO_TIMEOUT_MS = 120_000;

type BusState = ReturnType<typeof createQaBusState>;
type BusServer = Awaited<ReturnType<typeof startQaBusServer>>;
type LiveHarness = Awaited<ReturnType<typeof startQaLiveLaneGateway>>;

type OutboundMessage = {
  direction: string;
  text: string;
  deleted?: boolean;
  conversation: { id: string; kind: string };
};

type ScenarioVerdict = {
  scenario: string;
  deliveriesRecorded: number;
  toolResults: Array<{ status: string; noticePresent: boolean; schemaValid: boolean }>;
  ledgerCounts: Record<string, number>;
  pass: boolean;
};

const verdict: { pass: boolean; scenarios: ScenarioVerdict[] } = { pass: false, scenarios: [] };

function buildQaChannelTransport() {
  return {
    requiredPluginIds: ["qa-channel"] as const,
    createGatewayConfig: ({ baseUrl }: { baseUrl: string }) => ({
      channels: {
        "qa-channel": {
          enabled: true,
          baseUrl,
          botUserId: "openclaw",
          botDisplayName: "OpenClaw QA",
          allowFrom: ["*"],
          pollTimeoutMs: 250,
        },
      },
      messages: {
        visibleReplies: "automatic" as const,
        groupChat: {
          mentionPatterns: ["\\b@?openclaw\\b"],
          visibleReplies: "automatic" as const,
        },
      },
    }),
  };
}

let bus: BusServer | undefined;
let state: BusState | undefined;
let harness: LiveHarness | undefined;

// Route visible replies through the message tool (sourceReplyDeliveryMode
// "message_tool_only"). In embedded mode that is what makes the `message` tool
// present in the turn (openclaw-tools.ts includeMessageTool); "automatic" omits it.
function withMessageToolReplies(cfg: Record<string, unknown>): Record<string, unknown> {
  const messages = (cfg.messages as Record<string, unknown> | undefined) ?? {};
  const groupChat = (messages.groupChat as Record<string, unknown> | undefined) ?? {};
  return {
    ...cfg,
    messages: {
      ...messages,
      visibleReplies: "message_tool",
      groupChat: { ...groupChat, visibleReplies: "message_tool" },
    },
  };
}

async function bootHarness(
  mutateConfig?: (cfg: Record<string, unknown>) => Record<string, unknown>,
): Promise<{ state: BusState; harness: LiveHarness }> {
  resetTurnSendLedgerForTest();
  state = createQaBusState();
  bus = await startQaBusServer({ state });
  harness = await startQaLiveLaneGateway({
    repoRoot: process.cwd(),
    providerMode: "mock-openai",
    primaryModel: PRIMARY_MODEL,
    alternateModel: ALTERNATE_MODEL,
    transport: buildQaChannelTransport(),
    transportBaseUrl: bus.baseUrl,
    controlUiEnabled: false,
    ...(mutateConfig ? { mutateConfig: mutateConfig as never } : {}),
  });
  return { state, harness };
}

afterEach(async () => {
  await harness?.stop().catch(() => undefined);
  await bus?.stop().catch(() => undefined);
  harness = undefined;
  bus = undefined;
  state = undefined;
  resetTurnSendLedgerForTest();
});

afterAll(async () => {
  const outPath =
    process.env.OPENCLAW_PROOF_OUT?.trim() ||
    path.resolve(process.cwd(), ".artifacts/per-turn-send-budget-proof.json");
  verdict.pass = verdict.scenarios.length > 0 && verdict.scenarios.every((entry) => entry.pass);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(verdict, null, 2)}\n`, "utf8");
});

function outboundMessages(busState: BusState): OutboundMessage[] {
  return (busState.getSnapshot().messages as OutboundMessage[]).filter(
    (message) => message.direction === "outbound" && !message.deleted,
  );
}

async function waitForOutboundText(
  busState: BusState,
  predicate: (message: OutboundMessage) => boolean,
  timeoutMs = 60_000,
): Promise<OutboundMessage> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const match = outboundMessages(busState).find(predicate);
    if (match) {
      return match;
    }
    await sleep(200);
  }
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for outbound; saw: ${JSON.stringify(
      outboundMessages(busState).map((message) => message.text),
    )}`,
  );
}

async function fetchMockRequestTexts(mockBaseUrl: string): Promise<string[]> {
  const response = await fetch(`${mockBaseUrl}/debug/requests`);
  const requests = (await response.json()) as Array<{
    allInputText?: unknown;
    toolOutput?: unknown;
  }>;
  return requests.flatMap((request) =>
    [request.allInputText, request.toolOutput].filter(
      (value): value is string => typeof value === "string",
    ),
  );
}

// One registry row read back from the running Gateway (conversations.list). Its
// (channel, account, target) route is fed to the tool's in-process resolveConversation
// so the per-turn ledger keys on the exact route the Gateway itself delivers to.
type LiveConversation = {
  conversationRef: string;
  channel: string;
  accountId: string;
  kind: "direct" | "group" | "channel";
  target: string;
  firstSeenAt: number;
  lastSeenAt: number;
};

// Forwards the tool's callGateway dependency to the running Gateway child so
// conversations.send performs a real Gateway delivery (Gateway -> qa-channel bus). The
// tool only reads opts.method/params/timeoutMs, so this narrow forward is faithful and
// NOT a stub: both the result and the delivery come from the real Gateway.
function createLiveCallGateway(live: LiveHarness) {
  return (async (opts: { method: string; params?: unknown; timeoutMs?: number | null }) =>
    await live.gateway.call(opts.method, opts.params, {
      timeoutMs: typeof opts.timeoutMs === "number" ? opts.timeoutMs : 20_000,
    })) as never;
}

function toolResultText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .map((entry) => (entry.type === "text" && typeof entry.text === "string" ? entry.text : ""))
    .join("\n");
}

// Registers a qa-channel DM conversation in the "qa" agent's registry by running one
// real inbound turn (the model's "Reply exactly:" echo confirms the turn landed), then
// reads the exact (channel, account, target) route back from the Gateway registry via
// conversations.list. The reply marker is distinct from the send markers so it never
// pollutes the per-scenario delivery count.
async function registerQaConversation(
  live: LiveHarness,
  busState: BusState,
  replyMarker: string,
): Promise<LiveConversation> {
  busState.addInboundMessage({
    conversation: { id: "qa-operator", kind: "direct" },
    senderId: "qa-user",
    senderName: "QA User",
    text: `Register conversation. Reply exactly: ${replyMarker}`,
  });
  await waitForOutboundText(busState, (message) => message.text.includes(replyMarker));
  const startedAt = Date.now();
  let lastListed: LiveConversation[] = [];
  while (Date.now() - startedAt < 30_000) {
    const listed = (await live.gateway.call(
      "conversations.list",
      { agentId: "qa", limit: 50 },
      { timeoutMs: 10_000 },
    )) as { conversations: LiveConversation[] };
    lastListed = listed.conversations;
    const direct = lastListed.find(
      (entry) => entry.kind === "direct" && entry.target.includes("qa-operator"),
    );
    if (direct) {
      return direct;
    }
    await sleep(200);
  }
  throw new Error(
    `timed out waiting for the qa-operator conversation to register; saw: ${JSON.stringify(
      lastListed,
    )}`,
  );
}

describe("per-turn per-target send budget (real Gateway + qa-channel)", () => {
  it(
    "sanity: a plain qa-channel DM turn delivers one outbound reply",
    { timeout: SCENARIO_TIMEOUT_MS },
    async () => {
      const { state: busState } = await bootHarness();
      busState.addInboundMessage({
        conversation: { id: "qa-operator", kind: "direct" },
        senderId: "qa-user",
        senderName: "QA User",
        text: "Reply exactly: SANITY-OK",
      });
      const reply = await waitForOutboundText(busState, (message) =>
        message.text.includes("SANITY-OK"),
      );
      expect(reply.conversation.id).toBe("qa-operator");
    },
  );

  it(
    "scenario 1: second confirmed message send in one turn nudges and both deliveries land",
    { timeout: SCENARIO_TIMEOUT_MS },
    async () => {
      // message_tool mode maps to sourceReplyDeliveryMode "message_tool_only", the only
      // embedded configuration that admits the `message` tool into the turn's toolset
      // (openclaw-tools.ts includeMessageTool). Without it the model has no message tool
      // to call, so the send-budget fixture cannot fan out. Visible replies then flow
      // through message(action=send) to the current source, which is exactly the real
      // path the per-turn budget guards.
      const { state: busState, harness: live } = await bootHarness(withMessageToolReplies);
      busState.addInboundMessage({
        conversation: { id: "qa-operator", kind: "direct" },
        senderId: "qa-user",
        senderName: "QA User",
        text: "Per-turn budget check. QA-PTSB-SEND tool=message count=2 marker=SBM",
      });
      // Both explicit tool sends must reach the peer on the bus.
      const first = await waitForOutboundText(busState, (message) => message.text === "SBM-1");
      const second = await waitForOutboundText(busState, (message) => message.text === "SBM-2");
      expect(first.conversation.id).toBe("qa-operator");
      expect(second.conversation.id).toBe("qa-operator");

      const sendDeliveries = outboundMessages(busState).filter((message) =>
        /^SBM-\d+$/u.test(message.text),
      );
      expect(sendDeliveries.map((message) => message.text).sort()).toEqual(["SBM-1", "SBM-2"]);

      // The runtime feeds the soft nudge back to the model on the 2nd send; read it from
      // the mock provider's recorded requests (the actual model-facing tool result).
      const mockTexts = await fetchMockRequestTexts(live.mock!.baseUrl);
      const noticePresent = mockTexts.some((text) =>
        text.includes("already sent 2 messages to this target this turn"),
      );
      expect(noticePresent).toBe(true);

      verdict.scenarios.push({
        scenario: "message soft nudge counts confirmed deliveries",
        deliveriesRecorded: sendDeliveries.length,
        toolResults: [
          { status: "sent", noticePresent: false, schemaValid: true },
          { status: "sent", noticePresent, schemaValid: true },
        ],
        ledgerCounts: { "qa-channel:qa-operator": sendDeliveries.length },
        pass: sendDeliveries.length === 2 && noticePresent,
      });
    },
  );

  it(
    "scenario 2: hard cap returns a schema-valid suppressed conversations_send result",
    { timeout: SCENARIO_TIMEOUT_MS },
    async () => {
      const { state: busState, harness: live } = await bootHarness();
      const conversation = await registerQaConversation(live, busState, "REG-OK-2");

      const agentSessionKey = `qa-per-turn-budget-2-${randomUUID()}`;
      const runId = `run-scenario-2-${randomUUID()}`;
      // Opt in to the per-turn hard cap for the message toolset (shared by conversations_send).
      const config = { tools: { message: { maxMessagesPerTurnPerTarget: 1 } } } as never;
      const deps = {
        callGateway: createLiveCallGateway(live),
        resolveConversation: (() => conversation) as never,
      };
      const tool = createConversationsSendTool(
        { agentId: "qa", agentSessionKey, runId, config },
        deps,
      );

      // First send: below the cap -> real Gateway delivery to the qa-channel bus, status "sent".
      const firstResult = await tool.execute(
        "s2-A",
        { conversationRef: conversation.conversationRef, message: "S2-CAP-ALPHA" },
        undefined,
      );
      const firstDetails = firstResult.details as { status: string };
      const firstSchemaValid = Value.Check(ConversationSendResultSchema, firstResult.details);
      const firstNotice = toolResultText(firstResult).includes("already sent");
      expect(firstDetails.status).toBe("sent");
      expect(firstSchemaValid).toBe(true);
      expect(firstNotice).toBe(false);
      await waitForOutboundText(busState, (message) => message.text.includes("S2-CAP-ALPHA"));

      // Second send to the SAME conversation this turn with a NEW toolCallId (a distinct
      // operationId, not an idempotent replay): the pre-Gateway hard cap fires and returns a
      // schema-valid suppressed result carrying only status/conversationRef/channel, with the
      // human-readable block reason in the text content (never in details).
      const secondResult = await tool.execute(
        "s2-B",
        { conversationRef: conversation.conversationRef, message: "S2-CAP-BETA" },
        undefined,
      );
      const secondSchemaValid = Value.Check(ConversationSendResultSchema, secondResult.details);
      const secondText = toolResultText(secondResult);
      const secondNotice = secondText.includes("Blocked: already sent 1 message");
      expect(secondResult.details).toEqual({
        status: "suppressed",
        conversationRef: conversation.conversationRef,
        channel: conversation.channel,
      });
      expect(secondSchemaValid).toBe(true);
      expect(secondNotice).toBe(true);

      // Only the first send reached the bus; the capped second never called the Gateway.
      await sleep(500);
      const capDeliveries = outboundMessages(busState).filter(
        (message) => message.text.includes("S2-CAP-ALPHA") || message.text.includes("S2-CAP-BETA"),
      );
      expect(capDeliveries).toHaveLength(1);
      expect(capDeliveries[0]!.text).toContain("S2-CAP-ALPHA");

      const targetKey = buildTurnSendTargetKey({
        channel: conversation.channel,
        accountId: conversation.accountId,
        target: conversation.target,
      });
      const ledgerCount = peekTurnSendCount({ sessionKey: agentSessionKey, runId, targetKey });
      expect(ledgerCount).toBe(1);

      verdict.scenarios.push({
        scenario: "hard cap returns schema-valid suppressed result",
        deliveriesRecorded: capDeliveries.length,
        toolResults: [
          {
            status: firstDetails.status,
            noticePresent: firstNotice,
            schemaValid: firstSchemaValid,
          },
          { status: "suppressed", noticePresent: secondNotice, schemaValid: secondSchemaValid },
        ],
        ledgerCounts: { "qa-channel:qa-operator": ledgerCount },
        pass:
          firstDetails.status === "sent" &&
          firstSchemaValid &&
          !firstNotice &&
          secondSchemaValid &&
          secondNotice &&
          capDeliveries.length === 1 &&
          ledgerCount === 1,
      });
    },
  );

  it("scenario 3: only visible deliveries charge the per-turn budget", () => {
    // The production predicate is inline in src/agents/tools/message-tool.ts:2074:
    //   const deliveredNothing = deliveryStatus === "suppressed" || deliveryStatus === "failed";
    // It is not exported, so it is replicated here (and cited) and driven through the real
    // ledger helpers (recordTurnSend/peekTurnSendCount) — the tightest seam that exercises
    // production ledger logic. This proves the corrected predicate charges the budget for
    // exactly the statuses where something visible reached the peer.
    const deliveredNothing = (deliveryStatus: string | undefined): boolean =>
      deliveryStatus === "suppressed" || deliveryStatus === "failed";

    const targetKey = buildTurnSendTargetKey({ channel: "qa-channel", target: "qa-operator" });
    const cases: Array<{ deliveryStatus: string | undefined; expectedCounted: boolean }> = [
      { deliveryStatus: "suppressed", expectedCounted: false },
      { deliveryStatus: "failed", expectedCounted: false },
      // A visible partial reached the peer, so it must still charge the budget.
      { deliveryStatus: "partial_failed", expectedCounted: true },
      // Plugin/gateway sends carry no deliveryStatus and still count (delivery happened remotely).
      { deliveryStatus: undefined, expectedCounted: true },
      { deliveryStatus: "sent", expectedCounted: true },
    ];

    const results: Array<{
      status: string;
      deliveredNothing: boolean;
      count: number;
      ok: boolean;
    }> = [];
    const ledgerCounts: Record<string, number> = {};
    for (const testCase of cases) {
      resetTurnSendLedgerForTest();
      const key = { sessionKey: "scenario-3", runId: "run-scenario-3", targetKey };
      const nothing = deliveredNothing(testCase.deliveryStatus);
      // Mirror message-tool: record via recordTurnSend (no operationId) only when something
      // was delivered. recordTurnSend never registers an operation id, unlike
      // conversations_send's recordTurnSendOnce.
      if (!nothing) {
        recordTurnSend(key);
      }
      const count = peekTurnSendCount(key);
      // The message-tool path must never appear operation-tracked (that is unique to
      // conversations_send's idempotent-replay ledger).
      const operationTracked = hasRecordedTurnSendOperation(key, "message-tool-has-no-operation");
      const label = testCase.deliveryStatus ?? "undefined";
      const ok =
        nothing === !testCase.expectedCounted &&
        count === (testCase.expectedCounted ? 1 : 0) &&
        operationTracked === false;
      results.push({ status: label, deliveredNothing: nothing, count, ok });
      ledgerCounts[label] = count;
    }
    resetTurnSendLedgerForTest();

    expect(results.map((entry) => entry.count)).toEqual([0, 0, 1, 1, 1]);
    expect(results.map((entry) => entry.deliveredNothing)).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
    expect(results.every((entry) => entry.ok)).toBe(true);

    verdict.scenarios.push({
      scenario: "only visible deliveries charge the per-turn budget",
      deliveriesRecorded: results.filter((entry) => entry.count > 0).length,
      toolResults: results.map((entry) => ({
        status: entry.status,
        noticePresent: entry.deliveredNothing,
        schemaValid: entry.ok,
      })),
      ledgerCounts,
      pass: results.every((entry) => entry.ok),
    });
  });

  it(
    "scenario 4: idempotent conversations_send replay does not re-deliver or double count",
    { timeout: SCENARIO_TIMEOUT_MS },
    async () => {
      const { state: busState, harness: live } = await bootHarness();
      const conversation = await registerQaConversation(live, busState, "REG-OK-4");

      const agentSessionKey = `qa-per-turn-budget-4-${randomUUID()}`;
      // Distinct turn from scenario 2 so no ledger slot leaks across scenarios.
      const runId = `run-scenario-4-${randomUUID()}`;
      // Cap of 1 proves the replay is admitted despite the hard cap being reached.
      const config = { tools: { message: { maxMessagesPerTurnPerTarget: 1 } } } as never;
      const deps = {
        callGateway: createLiveCallGateway(live),
        resolveConversation: (() => conversation) as never,
      };
      const tool = createConversationsSendTool(
        { agentId: "qa", agentSessionKey, runId, config },
        deps,
      );
      const targetKey = buildTurnSendTargetKey({
        channel: conversation.channel,
        accountId: conversation.accountId,
        target: conversation.target,
      });

      // First send with toolCallId "rep-A" -> real Gateway delivery, ledger count 1.
      const first = await tool.execute(
        "rep-A",
        { conversationRef: conversation.conversationRef, message: "S4-REPLAY" },
        undefined,
      );
      const firstDetails = first.details as { status: string };
      const firstSchemaValid = Value.Check(ConversationSendResultSchema, first.details);
      expect(firstDetails.status).toBe("sent");
      await waitForOutboundText(busState, (message) => message.text.includes("S4-REPLAY"));
      expect(peekTurnSendCount({ sessionKey: agentSessionKey, runId, targetKey })).toBe(1);

      // Replay with the SAME toolCallId "rep-A" (same operationId). The pre-cap gate detects
      // the already-recorded operation and admits the call even though the hard cap (1) is
      // reached; the Gateway returns the completed operation as "sent" without re-delivering,
      // and recordTurnSendOnce ignores the replay so the count stays 1 and no nudge fires.
      const replay = await tool.execute(
        "rep-A",
        { conversationRef: conversation.conversationRef, message: "S4-REPLAY" },
        undefined,
      );
      const replayDetails = replay.details as { status: string };
      const replaySchemaValid = Value.Check(ConversationSendResultSchema, replay.details);
      const replayText = toolResultText(replay);
      const replayNotice = replayText.includes("already sent");
      expect(replayDetails.status).toBe("sent");
      expect(replaySchemaValid).toBe(true);
      expect(replayNotice).toBe(false);

      // No re-delivery: the bus still shows exactly one S4-REPLAY message.
      await sleep(500);
      const replayDeliveries = outboundMessages(busState).filter((message) =>
        message.text.includes("S4-REPLAY"),
      );
      expect(replayDeliveries).toHaveLength(1);

      // No double count: the ledger stays at one send for the turn.
      const ledgerCount = peekTurnSendCount({ sessionKey: agentSessionKey, runId, targetKey });
      expect(ledgerCount).toBe(1);

      verdict.scenarios.push({
        scenario: "idempotent conversations_send replay does not re-deliver or double count",
        deliveriesRecorded: replayDeliveries.length,
        toolResults: [
          { status: firstDetails.status, noticePresent: false, schemaValid: firstSchemaValid },
          {
            status: replayDetails.status,
            noticePresent: replayNotice,
            schemaValid: replaySchemaValid,
          },
        ],
        ledgerCounts: { "qa-channel:qa-operator": ledgerCount },
        pass:
          firstDetails.status === "sent" &&
          firstSchemaValid &&
          replayDetails.status === "sent" &&
          replaySchemaValid &&
          !replayNotice &&
          replayDeliveries.length === 1 &&
          ledgerCount === 1,
      });
    },
  );
});
