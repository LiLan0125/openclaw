import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";

type GatewayHelpers = typeof import("./test-helpers.server.js");
type GatewayHarness = Awaited<ReturnType<GatewayHelpers["createGatewaySuiteHarness"]>>;
type GatewayWs = Awaited<ReturnType<GatewayHarness["openWs"]>>;

let gatewayHelpers: GatewayHelpers | undefined;

function helpers(): GatewayHelpers {
  if (!gatewayHelpers) {
    throw new Error("gateway helpers are not ready");
  }
  return gatewayHelpers;
}

async function connectOk(...args: Parameters<GatewayHelpers["connectOk"]>) {
  return await helpers().connectOk(...args);
}

async function rpcReq(...args: Parameters<GatewayHelpers["rpcReq"]>) {
  return await helpers().rpcReq(...args);
}

function onceMessage(...args: Parameters<GatewayHelpers["onceMessage"]>) {
  return helpers().onceMessage(...args);
}

async function seedGatewaySessionEntries(
  ...args: Parameters<GatewayHelpers["seedGatewaySessionEntries"]>
) {
  return await helpers().seedGatewaySessionEntries(...args);
}

const cleanupDirs: string[] = [];
const SETUP_RPC_TIMEOUT_MS = 30_000;
let previousStateDir: string | undefined;
let previousStateDirCaptured = false;
let suiteHomeDir = "";
let suiteConfigRoot = "";
let previousEnv: Map<string, string | undefined> | undefined;
let harness: GatewayHarness;
let subscribedOperatorWs: GatewayWs | undefined;

const GATEWAY_TEST_ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_AGENT_DIR",
  "PI_CODING_AGENT_DIR",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
  "OPENCLAW_SKIP_GMAIL_WATCHER",
  "OPENCLAW_SKIP_CANVAS_HOST",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
  "OPENCLAW_SKIP_CHANNELS",
  "OPENCLAW_SKIP_PROVIDERS",
  "OPENCLAW_SKIP_CRON",
  "OPENCLAW_TEST_MINIMAL_GATEWAY",
] as const;

async function setupGatewaySuiteState() {
  previousEnv = new Map(GATEWAY_TEST_ENV_KEYS.map((key) => [key, process.env[key]] as const));
  suiteHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-message-home-"));
  suiteConfigRoot = path.join(suiteHomeDir, ".openclaw-test");
  const stateDir = path.join(suiteHomeDir, ".openclaw");
  await fs.mkdir(suiteConfigRoot, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });

  process.env.HOME = suiteHomeDir;
  process.env.USERPROFILE = suiteHomeDir;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  delete process.env.OPENCLAW_CONFIG_PATH;
  delete process.env.OPENCLAW_AGENT_DIR;
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
  process.env.OPENCLAW_SKIP_BROWSER_CONTROL_SERVER = "1";
  process.env.OPENCLAW_SKIP_GMAIL_WATCHER = "1";
  process.env.OPENCLAW_SKIP_CANVAS_HOST = "1";
  process.env.OPENCLAW_SKIP_CHANNELS = "1";
  process.env.OPENCLAW_SKIP_PROVIDERS = "1";
  process.env.OPENCLAW_SKIP_CRON = "1";
  process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = "1";
  process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
  process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = path.join(
    suiteHomeDir,
    "openclaw-test-no-bundled-extensions",
  );

  const { setTestConfigRoot, sessionStoreSaveDelayMs, testState } =
    await import("./test-helpers.runtime-state.js");
  setTestConfigRoot(suiteConfigRoot);
  sessionStoreSaveDelayMs.value = 0;
  testState.gatewayAuth = { mode: "token", token: "test-gateway-token-1234567890" };
  testState.gatewayControlUi = undefined;
  testState.allowFrom = undefined;

  const { resetConfigRuntimeState } = await import("../config/config.js");
  const { resetTestPluginRegistry } = await import("./test-helpers.plugin-registry.js");
  const { clearGatewaySubagentRuntime } = await import("../plugins/runtime/gateway-bindings.js");
  const { closeOpenClawAgentDatabasesForTest } = await import("../state/openclaw-agent-db.js");
  const { closeOpenClawStateDatabaseForTest } = await import("../state/openclaw-state-db.js");
  resetConfigRuntimeState();
  resetTestPluginRegistry();
  clearGatewaySubagentRuntime();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
}

async function cleanupGatewaySuiteState() {
  if (previousEnv) {
    for (const [key, value] of previousEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    previousEnv = undefined;
  }
  if (suiteHomeDir) {
    await fs.rm(suiteHomeDir, { recursive: true, force: true });
    suiteHomeDir = "";
    suiteConfigRoot = "";
  }
}

beforeAll(async () => {
  await setupGatewaySuiteState();
  await import("./test-helpers.mocks.js");
  gatewayHelpers = await import("./test-helpers.server.js");
  const { createGatewaySuiteHarness } = helpers();
  harness = await createGatewaySuiteHarness();
  subscribedOperatorWs = await harness.openWs();
  await connectOk(subscribedOperatorWs, {
    scopes: ["operator.read"],
    timeoutMs: SETUP_RPC_TIMEOUT_MS,
  });
  await rpcReq(subscribedOperatorWs, "sessions.subscribe", undefined, SETUP_RPC_TIMEOUT_MS);
}, 60_000);

afterAll(async () => {
  subscribedOperatorWs?.close();
  if (harness) {
    await harness.close();
  }
  await cleanupGatewaySuiteState();
});

afterEach(async () => {
  if (previousStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = previousStateDir;
  }
  previousStateDir = undefined;
  previousStateDirCaptured = false;
  await Promise.all(
    cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function setupTranscriptFixtureState(): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-message-"));
  cleanupDirs.push(dir);
  if (!previousStateDirCaptured) {
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    previousStateDirCaptured = true;
  }
  process.env.OPENCLAW_STATE_DIR = dir;
  const { closeOpenClawAgentDatabasesForTest } = await import("../state/openclaw-agent-db.js");
  const { closeOpenClawStateDatabaseForTest } = await import("../state/openclaw-state-db.js");
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
}

async function appendAssistantMessageToTranscript(
  params: Parameters<
    typeof import("../config/sessions/transcript.js").appendAssistantMessageToSessionTranscript
  >[0],
) {
  const { appendAssistantMessageToSessionTranscript } =
    await import("../config/sessions/transcript.js");
  return await appendAssistantMessageToSessionTranscript(params);
}

async function emitLifecycleEvent(
  params: Parameters<
    typeof import("../sessions/session-lifecycle-events.js").emitSessionLifecycleEvent
  >[0],
) {
  const { emitSessionLifecycleEvent } = await import("../sessions/session-lifecycle-events.js");
  emitSessionLifecycleEvent(params);
}

async function emitTranscriptUpdate(
  params: Parameters<
    typeof import("../sessions/transcript-events.js").emitSessionTranscriptUpdate
  >[0],
) {
  const { emitSessionTranscriptUpdate } = await import("../sessions/transcript-events.js");
  emitSessionTranscriptUpdate(params);
}

async function replaceTranscriptEvents(params: { sessionId: string; events: unknown[] }) {
  const { replaceSqliteSessionTranscriptEvents } =
    await import("../config/sessions/transcript-store.sqlite.js");
  replaceSqliteSessionTranscriptEvents({
    agentId: "main",
    sessionId: params.sessionId,
    events: params.events,
  });
}

async function withOperatorSessionSubscriber<T>(
  run: (ws: NonNullable<typeof subscribedOperatorWs>) => Promise<T>,
) {
  if (!subscribedOperatorWs) {
    throw new Error("subscribed operator websocket is not ready");
  }
  return await run(subscribedOperatorWs);
}

function waitForSessionMessageEvent(ws: GatewayWs, sessionKey: string) {
  return onceMessage(
    ws,
    (message) =>
      message.type === "event" &&
      message.event === "session.message" &&
      (message.payload as { sessionKey?: string } | undefined)?.sessionKey === sessionKey,
  );
}

function waitForSessionsChangedMessagePhase(ws: GatewayWs, sessionKey: string) {
  return onceMessage(
    ws,
    (message) =>
      message.type === "event" &&
      message.event === "sessions.changed" &&
      (message.payload as { phase?: string; sessionKey?: string } | undefined)?.phase ===
        "message" &&
      (message.payload as { sessionKey?: string } | undefined)?.sessionKey === sessionKey,
  );
}

async function emitTranscriptUpdateAndCollectMessageEvent(params: {
  ws: GatewayWs;
  sessionKey: string;
  sessionId: string;
  message: Record<string, unknown>;
  messageId: string;
  messageSeq?: number;
}) {
  const messageEventPromise = waitForSessionMessageEvent(params.ws, params.sessionKey);

  await emitTranscriptUpdate({
    agentId: "main",
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    message: params.message,
    messageId: params.messageId,
    ...(typeof params.messageSeq === "number" ? { messageSeq: params.messageSeq } : {}),
  });

  const messageEvent = await messageEventPromise;
  return { messageEvent };
}

async function expectNoMessageWithin(params: {
  action?: () => Promise<void> | void;
  watch: (timeoutMs: number) => Promise<unknown>;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 300;
  const received = params.watch(timeoutMs).then(
    () => true,
    () => false,
  );
  await params.action?.();
  await expect(received).resolves.toBe(false);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label} to be an object`);
  }
  return value as Record<string, unknown>;
}

function expectRecordFields(value: unknown, expected: Record<string, unknown>): void {
  const record = requireRecord(value, "record");
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key]).toEqual(expectedValue);
  }
}

describe("session.message websocket events", () => {
  test("includes spawned session ownership metadata on lifecycle sessions.changed events", async () => {
    await setupTranscriptFixtureState();
    await seedGatewaySessionEntries({
      entries: {
        child: {
          sessionId: "sess-child",
          updatedAt: Date.now(),
          spawnedBy: "agent:main:parent",
          spawnedWorkspaceDir: "/tmp/subagent-workspace",
          forkedFromParent: true,
          spawnDepth: 2,
          subagentRole: "orchestrator",
          subagentControlScope: "children",
          displayName: "Ops Child",
        },
      },
    });

    await withOperatorSessionSubscriber(async (ws) => {
      const changedEvent = onceMessage(
        ws,
        (message) =>
          message.type === "event" &&
          message.event === "sessions.changed" &&
          (message.payload as { sessionKey?: string } | undefined)?.sessionKey ===
            "agent:main:child",
      );

      await emitLifecycleEvent({
        sessionKey: "agent:main:child",
        reason: "reactivated",
      });

      const event = await changedEvent;
      expectRecordFields(event.payload, {
        sessionKey: "agent:main:child",
        reason: "reactivated",
        spawnedBy: "agent:main:parent",
        spawnedWorkspaceDir: "/tmp/subagent-workspace",
        forkedFromParent: true,
        spawnDepth: 2,
        subagentRole: "orchestrator",
        subagentControlScope: "children",
        displayName: "Ops Child",
      });
    });
  });

  test("only sends transcript events to subscribed operator clients", async () => {
    await setupTranscriptFixtureState();
    await seedGatewaySessionEntries({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
      },
    });

    const subscribedWs = await harness.openWs();
    const unsubscribedWs = await harness.openWs();
    const nodeWs = await harness.openWs();
    try {
      await connectOk(subscribedWs, { scopes: ["operator.read"] });
      await rpcReq(subscribedWs, "sessions.subscribe");
      await connectOk(unsubscribedWs, { scopes: ["operator.read"] });
      await connectOk(nodeWs, { role: "node", scopes: [] });

      const subscribedEvent = onceMessage(
        subscribedWs,
        (message) =>
          message.type === "event" &&
          message.event === "session.message" &&
          (message.payload as { sessionKey?: string } | undefined)?.sessionKey ===
            "agent:main:main",
      );
      const appended = await appendAssistantMessageToTranscript({
        sessionKey: "agent:main:main",
        text: "subscribed only",
      });
      expect(appended.ok).toBe(true);
      const event = await subscribedEvent;
      expectRecordFields(event, {
        type: "event",
        event: "session.message",
      });
      await expectNoMessageWithin({
        watch: (timeoutMs) =>
          onceMessage(
            unsubscribedWs,
            (message) => message.type === "event" && message.event === "session.message",
            timeoutMs,
          ),
      });
      await expectNoMessageWithin({
        watch: (timeoutMs) =>
          onceMessage(
            nodeWs,
            (message) => message.type === "event" && message.event === "session.message",
            timeoutMs,
          ),
      });
    } finally {
      subscribedWs.close();
      unsubscribedWs.close();
      nodeWs.close();
    }
  });

  test("broadcasts appended transcript messages with the session key", async () => {
    await setupTranscriptFixtureState();
    await seedGatewaySessionEntries({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
      },
    });

    const transcriptEvents = await import("../sessions/transcript-events.js");
    const emitSpy = vi.spyOn(transcriptEvents, "emitSessionTranscriptUpdate");
    try {
      const appended = await appendAssistantMessageToTranscript({
        sessionKey: "agent:main:main",
        text: "live websocket message",
      });
      expect(appended.ok).toBe(true);
      if (!appended.ok) {
        throw new Error(`append failed: ${appended.reason}`);
      }
      expect(emitSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "agent:main:main",
          messageId: appended.messageId,
          message: expect.objectContaining({
            role: "assistant",
            content: [{ type: "text", text: "live websocket message" }],
          }),
        }),
      );
      const { loadSqliteSessionTranscriptEvents } =
        await import("../config/sessions/transcript-store.sqlite.js");
      const transcript = loadSqliteSessionTranscriptEvents({
        agentId: "main",
        sessionId: "sess-main",
      }).map((entry) => entry.event);
      expect(transcript).toContainEqual(
        expect.objectContaining({
          message: expect.objectContaining({
            content: [{ type: "text", text: "live websocket message" }],
          }),
        }),
      );
    } finally {
      emitSpy.mockRestore();
    }
  });

  test("strips blocked original content from live session.message events", async () => {
    await setupTranscriptFixtureState();
    await seedGatewaySessionEntries({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
      },
    });
    await replaceTranscriptEvents({
      sessionId: "sess-main",
      events: [{ type: "session", version: 1, id: "sess-main" }],
    });

    await withOperatorSessionSubscriber(async (ws) => {
      const { messageEvent } = await emitTranscriptUpdateAndCollectMessageEvent({
        ws,
        sessionKey: "agent:main:main",
        sessionId: "sess-main",
        messageId: "blocked-1",
        message: {
          role: "user",
          content: [{ type: "text", text: "The agent cannot read this message." }],
          __openclaw: {
            beforeAgentRunBlocked: { blockedBy: "policy-plugin", blockedAt: 1 },
          },
        },
      });

      const payload = messageEvent.payload as {
        message?: { content?: unknown; __openclaw?: { beforeAgentRunBlocked?: unknown } };
      };
      expect(payload.message?.content).toEqual([
        { type: "text", text: "The agent cannot read this message." },
      ]);
      expect(JSON.stringify(payload.message)).not.toContain("secret blocked prompt");
      expect(JSON.stringify(payload.message)).not.toContain("contains protected content");
    });
  });

  test("broadcasts redacted blocked user appends to live session listeners", async () => {
    await setupTranscriptFixtureState();
    await seedGatewaySessionEntries({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
      },
    });

    await withOperatorSessionSubscriber(async (ws) => {
      const messageEventPromise = waitForSessionMessageEvent(ws, "agent:main:main");
      await emitTranscriptUpdate({
        agentId: "main",
        sessionId: "sess-main",
        sessionKey: "agent:main:main",
        messageId: "blocked-message",
        message: {
          role: "user",
          content: [{ type: "text", text: "The agent cannot read this message." }],
          __openclaw: {
            beforeAgentRunBlocked: {
              blockedBy: "policy-plugin",
              blockedAt: Date.now(),
            },
          },
        },
      });

      const messageEvent = await messageEventPromise;
      const payload = messageEvent.payload as {
        message?: {
          role?: unknown;
          content?: unknown;
          __openclaw?: { beforeAgentRunBlocked?: unknown };
        };
      };
      expect(payload.message?.role).toBe("user");
      expect(payload.message?.content).toEqual([
        { type: "text", text: "The agent cannot read this message." },
      ]);
      expect(JSON.stringify(payload.message)).not.toContain("secret blocked prompt");
      expect(JSON.stringify(payload.message)).not.toContain("contains protected content");
    });
  });

  test("does not broadcast hidden runtime-context custom messages as live chat messages", async () => {
    await setupTranscriptFixtureState();
    await seedGatewaySessionEntries({
      entries: {
        "hidden-runtime": {
          sessionId: "sess-hidden-runtime",
          updatedAt: Date.now(),
        },
      },
    });

    await withOperatorSessionSubscriber(async (ws) => {
      const changedEventPromise = waitForSessionsChangedMessagePhase(
        ws,
        "agent:main:hidden-runtime",
      );
      await expectNoMessageWithin({
        watch: (timeoutMs) =>
          onceMessage(
            ws,
            (message) =>
              message.type === "event" &&
              message.event === "session.message" &&
              (message.payload as { sessionKey?: string } | undefined)?.sessionKey ===
                "agent:main:hidden-runtime",
            timeoutMs,
          ),
        action: async () => {
          await emitTranscriptUpdate({
            agentId: "main",
            sessionId: "sess-hidden-runtime",
            sessionKey: "agent:main:hidden-runtime",
            messageId: "runtime-context-1",
            messageSeq: 1,
            message: {
              role: "custom",
              customType: "openclaw.runtime-context",
              content: "secret runtime context",
              display: false,
            },
          });
        },
      });

      const changedEvent = await changedEventPromise;
      expectRecordFields(changedEvent.payload, {
        sessionKey: "agent:main:hidden-runtime",
        phase: "message",
      });
    });
  });

  test("does not duplicate displayable transcript updates with sessions.changed", async () => {
    await setupTranscriptFixtureState();
    await seedGatewaySessionEntries({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
      },
    });
    await replaceTranscriptEvents({
      sessionId: "sess-main",
      events: [{ type: "session", version: 1, id: "sess-main" }],
    });

    await withOperatorSessionSubscriber(async (ws) => {
      const messageEventPromise = waitForSessionMessageEvent(ws, "agent:main:main");
      await expectNoMessageWithin({
        action: async () => {
          await emitTranscriptUpdate({
            agentId: "main",
            sessionId: "sess-main",
            sessionKey: "agent:main:main",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "single frame" }],
              timestamp: Date.now(),
            },
            messageId: "msg-single-frame",
            messageSeq: 1,
          });
        },
        watch: (timeoutMs) =>
          onceMessage(
            ws,
            (message) =>
              message.type === "event" &&
              message.event === "sessions.changed" &&
              (message.payload as { phase?: string; sessionKey?: string } | undefined)?.phase ===
                "message" &&
              (message.payload as { sessionKey?: string } | undefined)?.sessionKey ===
                "agent:main:main",
            timeoutMs,
          ),
      });
      const messageEvent = await messageEventPromise;
      expectRecordFields(messageEvent.payload, {
        sessionKey: "agent:main:main",
        messageId: "msg-single-frame",
        messageSeq: 1,
      });
    });
  });

  test("includes live usage metadata on session.message transcript events", async () => {
    await setupTranscriptFixtureState();
    await seedGatewaySessionEntries({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
          modelProvider: "openai",
          model: "gpt-5.4",
          contextTokens: 123_456,
          totalTokens: 0,
          totalTokensFresh: false,
        },
      },
    });
    const transcriptMessage = {
      role: "assistant",
      content: [{ type: "text", text: "usage snapshot" }],
      provider: "openai",
      model: "gpt-5.4",
      usage: {
        input: 2_000,
        output: 400,
        cacheRead: 300,
        cacheWrite: 100,
        cost: { total: 0.0042 },
      },
      timestamp: Date.now(),
    };
    await replaceTranscriptEvents({
      sessionId: "sess-main",
      events: [
        { type: "session", version: 1, id: "sess-main" },
        { id: "msg-usage", message: transcriptMessage },
      ],
    });

    await withOperatorSessionSubscriber(async (ws) => {
      const { messageEvent } = await emitTranscriptUpdateAndCollectMessageEvent({
        ws,
        sessionKey: "agent:main:main",
        sessionId: "sess-main",
        message: transcriptMessage,
        messageId: "msg-usage",
      });
      expectRecordFields(messageEvent.payload, {
        sessionKey: "agent:main:main",
        messageId: "msg-usage",
        messageSeq: 1,
        totalTokens: 2_400,
        totalTokensFresh: true,
        contextTokens: 123_456,
        estimatedCostUsd: 0.0042,
        modelProvider: "openai",
        model: "gpt-5.4",
      });
    });
  });

  test("prefers carried transcript sequence for live session events", async () => {
    await setupTranscriptFixtureState();
    await seedGatewaySessionEntries({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
      },
    });

    await withOperatorSessionSubscriber(async (ws) => {
      const { messageEvent } = await emitTranscriptUpdateAndCollectMessageEvent({
        ws,
        sessionKey: "agent:main:main",
        sessionId: "sess-main",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "carried sequence" }],
          timestamp: Date.now(),
        },
        messageId: "msg-carried-seq",
        messageSeq: 7,
      });
      expectRecordFields(messageEvent.payload, {
        sessionKey: "agent:main:main",
        messageId: "msg-carried-seq",
        messageSeq: 7,
      });
      const payload = requireRecord(messageEvent.payload, "session.message payload");
      const message = requireRecord(payload.message, "session.message payload message");
      expect((message["__openclaw"] as { seq?: unknown } | undefined)?.seq).toBe(7);
    });
  });

  test("derives message sequence for selected-session transcript subscribers", async () => {
    await setupTranscriptFixtureState();
    await seedGatewaySessionEntries({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
      },
    });
    const transcriptMessage = {
      role: "user",
      content: [{ type: "text", text: "early selected prompt" }],
      timestamp: Date.now(),
    };
    await replaceTranscriptEvents({
      sessionId: "sess-main",
      events: [
        { type: "session", version: 1, id: "sess-main" },
        { id: "msg-selected", message: transcriptMessage },
      ],
    });

    const ws = await harness.openWs();
    try {
      await connectOk(ws, { scopes: ["operator.read"] });
      const subscribeRes = await rpcReq(ws, "sessions.messages.subscribe", {
        key: "main",
      });
      expect(subscribeRes.ok).toBe(true);
      expect(subscribeRes.payload?.key).toBe("agent:main:main");

      const messageEventPromise = waitForSessionMessageEvent(ws, "agent:main:main");
      await emitTranscriptUpdate({
        agentId: "main",
        sessionId: "sess-main",
        sessionKey: "agent:main:main",
        message: transcriptMessage,
        messageId: "msg-selected",
      });

      const messageEvent = await messageEventPromise;
      expectRecordFields(messageEvent.payload, {
        sessionKey: "agent:main:main",
        messageId: "msg-selected",
        messageSeq: 1,
      });
    } finally {
      ws.close();
    }
  });

  test("includes spawnedBy metadata on session.message transcript events", async () => {
    await setupTranscriptFixtureState();
    await seedGatewaySessionEntries({
      entries: {
        child: {
          sessionId: "sess-child",
          updatedAt: Date.now(),
          spawnedBy: "agent:main:main",
          spawnedWorkspaceDir: "/tmp/subagent-workspace",
          forkedFromParent: true,
          spawnDepth: 2,
          subagentRole: "orchestrator",
          subagentControlScope: "children",
          parentSessionKey: "agent:main:main",
        },
      },
    });
    const transcriptMessage = {
      role: "assistant",
      content: [{ type: "text", text: "spawn metadata snapshot" }],
      timestamp: Date.now(),
    };
    await replaceTranscriptEvents({
      sessionId: "sess-child",
      events: [
        { type: "session", version: 1, id: "sess-child" },
        { id: "msg-spawn", message: transcriptMessage },
      ],
    });

    const ws = await harness.openWs();
    try {
      await connectOk(ws, { scopes: ["operator.read"] });
      await rpcReq(ws, "sessions.subscribe");

      const messageEventPromise = onceMessage(
        ws,
        (message) =>
          message.type === "event" &&
          message.event === "session.message" &&
          (message.payload as { sessionKey?: string } | undefined)?.sessionKey ===
            "agent:main:child",
      );

      await emitTranscriptUpdate({
        agentId: "main",
        sessionId: "sess-child",
        sessionKey: "agent:main:child",
        message: transcriptMessage,
        messageId: "msg-spawn",
      });

      const messageEvent = await messageEventPromise;
      expectRecordFields(messageEvent.payload, {
        sessionKey: "agent:main:child",
        spawnedBy: "agent:main:main",
        spawnedWorkspaceDir: "/tmp/subagent-workspace",
        forkedFromParent: true,
        spawnDepth: 2,
        subagentRole: "orchestrator",
        subagentControlScope: "children",
        parentSessionKey: "agent:main:main",
      });
    } finally {
      ws.close();
    }
  });

  test("includes route thread metadata on session.message transcript events", async () => {
    await setupTranscriptFixtureState();
    await seedGatewaySessionEntries({
      entries: {
        main: {
          sessionId: "sess-thread",
          updatedAt: Date.now(),
          channel: "telegram",
          deliveryContext: {
            channel: "telegram",
            to: "-100123",
            accountId: "acct-1",
            threadId: 42,
          },
        },
      },
    });
    const transcriptMessage = {
      role: "assistant",
      content: [{ type: "text", text: "thread route snapshot" }],
      timestamp: Date.now(),
    };
    await replaceTranscriptEvents({
      sessionId: "sess-thread",
      events: [
        { type: "session", version: 1, id: "sess-thread" },
        { id: "msg-thread", message: transcriptMessage },
      ],
    });

    await withOperatorSessionSubscriber(async (ws) => {
      const { messageEvent } = await emitTranscriptUpdateAndCollectMessageEvent({
        ws,
        sessionKey: "agent:main:main",
        sessionId: "sess-thread",
        message: transcriptMessage,
        messageId: "msg-thread",
      });
      expectRecordFields(messageEvent.payload, {
        sessionKey: "agent:main:main",
        deliveryContext: {
          channel: "telegram",
          to: "-100123",
          accountId: "acct-1",
          chatType: "direct",
          threadId: "42",
        },
      });
    });
  });

  test("sessions.messages.subscribe only delivers transcript events for the requested session", async () => {
    await setupTranscriptFixtureState();
    await seedGatewaySessionEntries({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
        worker: {
          sessionId: "sess-worker",
          updatedAt: Date.now(),
        },
      },
    });

    const ws = await harness.openWs();
    try {
      await connectOk(ws, { scopes: ["operator.read"] });
      const subscribeRes = await rpcReq(ws, "sessions.messages.subscribe", {
        key: "agent:main:main",
      });
      expect(subscribeRes.ok).toBe(true);
      expect(subscribeRes.payload?.subscribed).toBe(true);
      expect(subscribeRes.payload?.key).toBe("agent:main:main");

      const mainEvent = waitForSessionMessageEvent(ws, "agent:main:main");
      const [mainAppend] = await Promise.all([
        appendAssistantMessageToTranscript({
          sessionKey: "agent:main:main",
          text: "main only",
        }),
        mainEvent,
      ]);
      expect(mainAppend.ok).toBe(true);

      await expectNoMessageWithin({
        watch: (timeoutMs) =>
          onceMessage(
            ws,
            (message) =>
              message.type === "event" &&
              message.event === "session.message" &&
              (message.payload as { sessionKey?: string } | undefined)?.sessionKey ===
                "agent:main:worker",
            timeoutMs,
          ),
        action: async () => {
          const workerAppend = await appendAssistantMessageToTranscript({
            sessionKey: "agent:main:worker",
            text: "worker hidden",
          });
          expect(workerAppend.ok).toBe(true);
        },
      });

      const unsubscribeRes = await rpcReq(ws, "sessions.messages.unsubscribe", {
        key: "agent:main:main",
      });
      expect(unsubscribeRes.ok).toBe(true);
      expect(unsubscribeRes.payload?.subscribed).toBe(false);

      await expectNoMessageWithin({
        watch: (timeoutMs) =>
          onceMessage(
            ws,
            (message) =>
              message.type === "event" &&
              message.event === "session.message" &&
              (message.payload as { sessionKey?: string } | undefined)?.sessionKey ===
                "agent:main:main",
            timeoutMs,
          ),
        action: async () => {
          const hiddenAppend = await appendAssistantMessageToTranscript({
            sessionKey: "agent:main:main",
            text: "hidden after unsubscribe",
          });
          expect(hiddenAppend.ok).toBe(true);
        },
      });
    } finally {
      ws.close();
    }
  });
});
