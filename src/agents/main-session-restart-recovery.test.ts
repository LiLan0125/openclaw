import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import { listSessionEntries, upsertSessionEntry } from "../config/sessions/store.js";
import { replaceSqliteSessionTranscriptEvents } from "../config/sessions/transcript-store.sqlite.js";
import { callGateway } from "../gateway/call.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
} from "./internal-runtime-context.js";
import { recoverRestartAbortedMainSessions } from "./main-session-restart-recovery.js";

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async () => ({ runId: "run-resumed" })),
}));

let tmpDir: string;

beforeEach(async () => {
  vi.clearAllMocks();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-main-restart-recovery-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", tmpDir);
});

afterEach(async () => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeSessionEntries(entries: Record<string, SessionEntry>): Promise<void> {
  for (const [sessionKey, entry] of Object.entries(entries)) {
    upsertSessionEntry({ agentId: "main", sessionKey, entry });
  }
}

function readSessionEntries(): Record<string, SessionEntry> {
  return Object.fromEntries(
    listSessionEntries({ agentId: "main" }).map(({ sessionKey, entry }) => [sessionKey, entry]),
  );
}

async function writeTranscript(sessionId: string, messages: unknown[]): Promise<void> {
  replaceSqliteSessionTranscriptEvents({
    agentId: "main",
    sessionId,
    events: [
      {
        type: "session",
        version: 1,
        id: sessionId,
        timestamp: new Date().toISOString(),
        cwd: process.cwd(),
      },
      ...messages.map((message, index) => ({
        type: "message",
        id: `msg-${index}`,
        parentId: index === 0 ? null : `msg-${index - 1}`,
        timestamp: new Date().toISOString(),
        message,
      })),
    ],
  });
}

function firstGatewayParams(): Record<string, unknown> {
  const call = vi.mocked(callGateway).mock.calls[0];
  if (!call) {
    throw new Error("expected gateway call");
  }
  const params = call[0].params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("expected gateway params");
  }
  return params as Record<string, unknown>;
}

describe("main-session-restart-recovery", () => {
  it("resumes marked sessions with a tool-result transcript tail", async () => {
    await writeSessionEntries({
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
      },
    });
    await writeTranscript("main-session", [
      { role: "user", content: "run the tool" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "exec" }] },
      { role: "toolResult", content: "done" },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 1, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
    const resumeParams = vi.mocked(callGateway).mock.calls.at(0)?.[0].params as
      | { sessionKey?: string; deliver?: boolean; lane?: string }
      | undefined;
    expect(resumeParams?.sessionKey).toBe("agent:main:main");
    expect(resumeParams?.deliver).toBe(false);
    expect(resumeParams?.lane).toBe("main");
    const store = readSessionEntries();
    expect(store["agent:main:main"]?.abortedLastRun).toBe(false);
  });

  it("fails marked sessions with stale approval-pending exec tool results", async () => {
    await writeSessionEntries({
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
      },
    });
    await writeTranscript("main-session", [
      { role: "user", content: "run a command that needs approval" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "exec" }] },
      {
        role: "toolResult",
        content: "Approval required (id stale, full stale-approval-id).",
        details: {
          status: "approval-pending",
          approvalId: "stale-approval-id",
          host: "gateway",
          command: "echo stale",
        },
      },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 0, failed: 1, skipped: 0 });
    expect(callGateway).not.toHaveBeenCalled();
    const store = readSessionEntries();
    expect(store["agent:main:main"]?.status).toBe("failed");
    expect(store["agent:main:main"]?.abortedLastRun).toBe(true);
  });

  it("resumes marked sessions with a durable pending final delivery payload (Phase 2)", async () => {
    const pendingPayload = "The final answer is 42.";
    await writeSessionEntries({
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
        pendingFinalDelivery: true,
        pendingFinalDeliveryText: pendingPayload,
        pendingFinalDeliveryCreatedAt: Date.now() - 5_000,
      },
    });
    await writeTranscript("main-session", [
      { role: "user", content: "calculate the answer" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "calc" }] },
      { role: "toolResult", content: "42" },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 1, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
    expect(firstGatewayParams().message).toContain(pendingPayload);

    const beforeStoreRead = Date.now();
    const store = readSessionEntries();
    const entry = store["agent:main:main"];
    expect(entry?.abortedLastRun).toBe(false);
    expect(entry?.pendingFinalDelivery).toBe(true);
    expect(entry?.pendingFinalDeliveryText).toBe(pendingPayload);
    expect(entry?.pendingFinalDeliveryAttemptCount).toBe(1);
    expect(entry?.pendingFinalDeliveryLastError).toBeNull();
    expect(entry?.pendingFinalDeliveryCreatedAt).toBeLessThanOrEqual(beforeStoreRead);
    expect(entry?.pendingFinalDeliveryLastAttemptAt).toBeLessThanOrEqual(beforeStoreRead);
    expect(entry?.pendingFinalDeliveryLastAttemptAt ?? 0).toBeGreaterThanOrEqual(
      entry?.pendingFinalDeliveryCreatedAt ?? Number.POSITIVE_INFINITY,
    );
  });

  it("sanitizes durable pending final delivery payloads before resume prompts", async () => {
    const pendingPayload = [
      "The final answer is 42.",
      INTERNAL_RUNTIME_CONTEXT_BEGIN,
      "internal recovery detail",
      INTERNAL_RUNTIME_CONTEXT_END,
      "",
      "Conversation info (untrusted metadata):",
      "```json",
      '{"message_id":"msg-1"}',
      "```",
    ].join("\n");
    await writeSessionEntries({
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
        pendingFinalDelivery: true,
        pendingFinalDeliveryText: pendingPayload,
        pendingFinalDeliveryCreatedAt: Date.now() - 5_000,
      },
    });
    await writeTranscript("main-session", [
      { role: "user", content: "calculate the answer" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "calc" }] },
      { role: "toolResult", content: "42" },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 1, failed: 0, skipped: 0 });
    expect(firstGatewayParams().message).toContain("The final answer is 42.");
    expect(firstGatewayParams().message).not.toContain(INTERNAL_RUNTIME_CONTEXT_BEGIN);
    expect(firstGatewayParams().message).not.toContain("Conversation info");

    const store = readSessionEntries();
    expect(store["agent:main:main"]?.pendingFinalDeliveryText).toBe("The final answer is 42.");
  });

  it("does not scan ordinary running sessions without the restart-aborted marker", async () => {
    await writeSessionEntries({
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
      },
    });
    await writeTranscript("main-session", [
      { role: "user", content: "current process owns this" },
      { role: "toolResult", content: "done" },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 0, failed: 0, skipped: 0 });
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("fails marked sessions whose transcript tail cannot be resumed", async () => {
    await writeSessionEntries({
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
      },
    });
    await writeTranscript("main-session", [
      { role: "user", content: "hello" },
      { role: "assistant", content: "partial answer" },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 0, failed: 1, skipped: 0 });
    expect(callGateway).not.toHaveBeenCalled();
    const store = readSessionEntries();
    expect(store["agent:main:main"]?.status).toBe("failed");
    expect(store["agent:main:main"]?.abortedLastRun).toBe(true);
  });

  it("sends a visible notice before failing an unresumable chat-bound main session", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:demo-channel:room-1": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
        deliveryContext: {
          channel: "demo-channel",
          to: "room-1",
          accountId: "default",
          threadId: "thread-1",
        },
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "do the thing" },
      { role: "assistant", content: "partial answer" },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 0, failed: 1, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
    const gatewayCall = vi.mocked(callGateway).mock.calls[0]?.[0] as
      | { method?: string; params?: Record<string, unknown> }
      | undefined;
    expect(gatewayCall?.method).toBe("message.action");
    expect(gatewayCall?.params).toMatchObject({
      channel: "demo-channel",
      action: "send",
      accountId: "default",
      sessionKey: "agent:main:demo-channel:room-1",
      sessionId: "main-session",
    });
    expect(gatewayCall?.params?.params).toMatchObject({
      to: "room-1",
      threadId: "thread-1",
      bestEffort: true,
    });
    expect(String((gatewayCall?.params?.params as Record<string, unknown>)?.message)).toContain(
      "couldn't safely resume",
    );

    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:demo-channel:room-1"]?.status).toBe("failed");
    expect(store["agent:main:demo-channel:room-1"]?.abortedLastRun).toBe(true);
  });
});
