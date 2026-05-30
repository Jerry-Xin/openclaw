import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSourceDeliveryPlan } from "../../infra/outbound/source-delivery-plan.js";
import type { SkillSnapshot } from "../../skills/types.js";
import type { MutableCronSession } from "./run-session-state.js";
import {
  clearFastTestEnv,
  makeCronSession,
  mockRunCronFallbackPassthrough,
  resolveCronDeliveryPlanMock,
  resetRunCronIsolatedAgentTurnHarness,
  restoreFastTestEnv,
  runEmbeddedAgentMock,
} from "./run.test-harness.js";

const { createCronPromptExecutor, executeCronRun } = await import("./run-executor.js");
const { resolveFallbackCronSourceDeliveryPlan } = await import("./source-delivery-fallback.js");

const emptySkillsSnapshot: SkillSnapshot = {
  prompt: "",
  skills: [],
  resolvedSkills: [],
  version: 1,
};

function makeJob(delivery: Record<string, unknown> = { mode: "none" }) {
  return {
    id: "source-delivery-guard",
    name: "Source Delivery Guard",
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    payload: { kind: "agentTurn", message: "test" },
    delivery,
  } as never;
}

function makeExecutor(overrides: Partial<Parameters<typeof createCronPromptExecutor>[0]>) {
  const resolvedDelivery = overrides.resolvedDelivery ?? {};

  return createCronPromptExecutor({
    cfg: {},
    cfgWithAgentDefaults: {},
    job: makeJob(),
    agentId: "default",
    agentDir: "/tmp/agent-dir",
    agentSessionKey: "cron:source-delivery-guard",
    runSessionKey: "cron:source-delivery-guard:run:test-session-id",
    workspaceDir: "/tmp/workspace",
    resolvedVerboseLevel: "off",
    thinkLevel: undefined,
    timeoutMs: 60_000,
    suppressExecNotifyOnExit: true,
    skillsSnapshot: emptySkillsSnapshot,
    agentPayload: null,
    useSubagentFallbacks: false,
    liveSelection: {
      provider: "openai",
      model: "gpt-5.4",
    },
    cronSession: makeCronSession() as MutableCronSession,
    abortReason: () => "aborted",
    ...overrides,
    resolvedDelivery,
  });
}

function getEmbeddedRunArg(): Record<string, unknown> {
  const call = runEmbeddedAgentMock.mock.calls[0];
  if (!call) {
    throw new Error("expected runEmbeddedAgent to be called");
  }
  return call[0] as Record<string, unknown>;
}

describe("createCronPromptExecutor sourceDelivery guard", () => {
  let previousFastTestEnv: string | undefined;

  beforeEach(() => {
    resetRunCronIsolatedAgentTurnHarness();
    previousFastTestEnv = clearFastTestEnv();
  });

  afterEach(() => {
    restoreFastTestEnv(previousFastTestEnv);
  });

  it("reconstructs a mode=none delivery plan when sourceDelivery is undefined", async () => {
    mockRunCronFallbackPassthrough();
    const executor = makeExecutor({
      sourceDelivery: undefined,
      job: makeJob({ mode: "none" }),
      resolvedDelivery: {
        channel: "messagechat",
        accountId: "acct-1",
        threadId: "thread-99",
      },
    });

    await executor.runPrompt("run a task");

    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    const args = getEmbeddedRunArg();
    expect(args.sourceReplyDeliveryMode).toBeUndefined();
    expect(args.requireExplicitMessageTarget).toBe(false);
    expect(args.disableMessageTool).toBe(false);
    expect(args.forceMessageTool).toBe(false);
    expect(args.agentAccountId).toBe("acct-1");
    expect(args.messageThreadId).toBe("thread-99");
  });

  it("uses resolvedDelivery channel/to for legacy callers without sourceDelivery", async () => {
    mockRunCronFallbackPassthrough();
    const executor = makeExecutor({
      sourceDelivery: undefined,
      job: makeJob({ mode: "none" }),
      resolvedDelivery: { channel: "topicchat", to: "room#42" },
    });

    await executor.runPrompt("run a task");

    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    const args = getEmbeddedRunArg();
    expect(args.messageChannel).toBe("topicchat");
    expect(args.messageTo).toBe("room#42");
  });

  it("disables the message tool for webhook delivery mode", async () => {
    mockRunCronFallbackPassthrough();
    resolveCronDeliveryPlanMock.mockReturnValue({ requested: false, mode: "webhook" });
    const executor = makeExecutor({
      sourceDelivery: undefined,
      job: makeJob({ mode: "webhook" }),
      resolvedDelivery: { channel: "messagechat", to: "123" },
    });

    await executor.runPrompt("run a task");

    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    const args = getEmbeddedRunArg();
    expect(args.sourceReplyDeliveryMode).toBeUndefined();
    expect(args.disableMessageTool).toBe(true);
    expect(args.forceMessageTool).toBe(false);
  });

  it("uses direct fallback semantics for announce delivery mode", async () => {
    mockRunCronFallbackPassthrough();
    resolveCronDeliveryPlanMock.mockReturnValue({ requested: true, mode: "announce" });
    const executor = makeExecutor({
      sourceDelivery: undefined,
      job: makeJob({ mode: "announce" }),
      resolvedDelivery: { channel: "messagechat", to: "456" },
    });

    await executor.runPrompt("run a task");

    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    const args = getEmbeddedRunArg();
    expect(args.sourceReplyDeliveryMode).toBeUndefined();
    expect(args.disableMessageTool).toBe(false);
    expect(args.forceMessageTool).toBe(false);
  });

  it("ignores stale sourceReplyDeliveryMode when sourceDelivery is missing", async () => {
    mockRunCronFallbackPassthrough();
    resolveCronDeliveryPlanMock.mockReturnValue({ requested: true, mode: "announce" });
    const executor = makeExecutor({
      sourceDelivery: undefined,
      job: makeJob({ mode: "announce" }),
      resolvedDelivery: { channel: "messagechat", to: "789" },
      sourceReplyDeliveryMode: "message_tool_only",
    } as never);

    await executor.runPrompt("run a task");

    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    const args = getEmbeddedRunArg();
    expect(args.sourceReplyDeliveryMode).toBeUndefined();
    expect(args.disableMessageTool).toBe(false);
    expect(args.forceMessageTool).toBe(false);
  });

  it("still works with a valid sourceDelivery", async () => {
    mockRunCronFallbackPassthrough();
    const executor = makeExecutor({
      sourceDelivery: createSourceDeliveryPlan({
        owner: "message_tool_then_direct_fallback",
        reason: "cron_announce",
        target: { channel: "messagechat", to: "123" },
        messageToolEnabled: true,
        messageToolForced: true,
        directFallback: true,
      }),
      resolvedDelivery: { channel: "messagechat", to: "123" },
    });

    await executor.runPrompt("send a message");

    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    const args = getEmbeddedRunArg();
    expect(args.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(args.requireExplicitMessageTarget).toBe(false);
    expect(args.disableMessageTool).toBe(false);
    expect(args.forceMessageTool).toBe(true);
    expect(args.messageChannel).toBe("messagechat");
  });
});

describe("resolveFallbackCronSourceDeliveryPlan", () => {
  it("creates an announce direct fallback plan with current cron semantics", () => {
    resolveCronDeliveryPlanMock.mockReturnValue({ requested: true, mode: "announce" });
    const plan = resolveFallbackCronSourceDeliveryPlan({
      job: makeJob({ mode: "announce" }),
      resolvedDelivery: { ok: true, channel: "messagechat", to: "123" },
    });

    expect(plan.owner).toBe("direct_fallback");
    expect(plan.reason).toBe("cron_announce");
    expect(plan.sourceReplyDeliveryMode).toBeUndefined();
    expect(plan.messageTool.enabled).toBe(true);
    expect(plan.messageTool.force).toBe(false);
    expect(plan.fallback.directDelivery).toBe(true);
    expect(plan.fallback.skipWhenMessageToolSentToTarget).toBe(true);
  });

  it("ignores stale legacy messageChannel when resolvedDelivery has no channel", () => {
    resolveCronDeliveryPlanMock.mockReturnValue({ requested: false, mode: "none" });
    const plan = resolveFallbackCronSourceDeliveryPlan({
      job: makeJob({ mode: "none" }),
      resolvedDelivery: { to: "123" },
    });

    expect(plan.target.channel).toBeUndefined();
    expect(plan.messageTool.force).toBe(false);
  });
});

function makeExecuteCronRunParams(overrides: Record<string, unknown> = {}) {
  return {
    cfg: {},
    cfgWithAgentDefaults: {},
    job: makeJob(),
    agentId: "default",
    agentDir: "/tmp/agent-dir",
    agentSessionKey: "cron:source-delivery-guard",
    runSessionKey: "cron:source-delivery-guard:run:test-session-id",
    workspaceDir: "/tmp/workspace",
    skillsSnapshot: emptySkillsSnapshot,
    agentPayload: null,
    useSubagentFallbacks: false,
    agentVerboseDefault: undefined,
    liveSelection: {
      provider: "openai",
      model: "gpt-5.4",
    },
    cronSession: makeCronSession() as MutableCronSession,
    commandBody: "run a task",
    persistSessionEntry: vi.fn().mockResolvedValue(undefined),
    abortReason: () => "aborted",
    isAborted: () => false,
    thinkLevel: undefined,
    timeoutMs: 60_000,
    suppressExecNotifyOnExit: true,
    resolvedDelivery: {},
    sourceDelivery: undefined,
    ...overrides,
  } as never;
}

describe("executeCronRun sourceDelivery guard", () => {
  let previousFastTestEnv: string | undefined;

  beforeEach(() => {
    resetRunCronIsolatedAgentTurnHarness();
    previousFastTestEnv = clearFastTestEnv();
  });

  afterEach(() => {
    restoreFastTestEnv(previousFastTestEnv);
  });

  it("ignores legacy sourceReplyDeliveryMode: message_tool_only through executeCronRun", async () => {
    mockRunCronFallbackPassthrough();
    resolveCronDeliveryPlanMock.mockReturnValue({ requested: true, mode: "announce" });
    await executeCronRun(
      makeExecuteCronRunParams({
        sourceDelivery: undefined,
        job: makeJob({ mode: "announce" }),
        resolvedDelivery: { channel: "messagechat", to: "123" },
        sourceReplyDeliveryMode: "message_tool_only",
      }),
    );

    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    const args = getEmbeddedRunArg();
    expect(args.sourceReplyDeliveryMode).toBeUndefined();
    expect(args.disableMessageTool).toBe(false);
    expect(args.forceMessageTool).toBe(false);
  });

  it("defaults to sourceReplyDeliveryMode undefined when legacy mode is absent", async () => {
    mockRunCronFallbackPassthrough();
    await executeCronRun(
      makeExecuteCronRunParams({
        sourceDelivery: undefined,
        job: makeJob({ mode: "none" }),
        resolvedDelivery: { channel: "messagechat", to: "456" },
      }),
    );

    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    const args = getEmbeddedRunArg();
    expect(args.sourceReplyDeliveryMode).toBeUndefined();
  });

  it("uses webhook message tool disabled fallback through executeCronRun", async () => {
    mockRunCronFallbackPassthrough();
    resolveCronDeliveryPlanMock.mockReturnValue({ requested: false, mode: "webhook" });
    await executeCronRun(
      makeExecuteCronRunParams({
        sourceDelivery: undefined,
        job: makeJob({ mode: "webhook" }),
        resolvedDelivery: { channel: "messagechat", to: "789" },
      }),
    );

    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    const args = getEmbeddedRunArg();
    expect(args.requireExplicitMessageTarget).toBe(false);
    expect(args.sourceReplyDeliveryMode).toBeUndefined();
    expect(args.disableMessageTool).toBe(true);
    expect(args.forceMessageTool).toBe(false);
  });

  it("passes requireExplicitMessageTarget=false by default when legacy toolPolicy omits it", async () => {
    mockRunCronFallbackPassthrough();
    await executeCronRun(
      makeExecuteCronRunParams({
        sourceDelivery: undefined,
        job: makeJob({ mode: "none" }),
        resolvedDelivery: { channel: "messagechat", to: "101" },
      }),
    );

    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    const args = getEmbeddedRunArg();
    expect(args.requireExplicitMessageTarget).toBe(false);
  });

  it("uses announce direct fallback defaults through executeCronRun", async () => {
    mockRunCronFallbackPassthrough();
    resolveCronDeliveryPlanMock.mockReturnValue({ requested: true, mode: "announce" });
    await executeCronRun(
      makeExecuteCronRunParams({
        sourceDelivery: undefined,
        job: makeJob({ mode: "announce" }),
        resolvedDelivery: { channel: "messagechat", to: "202" },
      }),
    );

    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    const args = getEmbeddedRunArg();
    expect(args.sourceReplyDeliveryMode).toBeUndefined();
    expect(args.disableMessageTool).toBe(false);
    expect(args.forceMessageTool).toBe(false);
  });
});
