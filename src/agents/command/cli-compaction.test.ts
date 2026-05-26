import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertSessionEntry } from "../../config/sessions/store.js";
import { replaceSqliteSessionTranscriptEvents } from "../../config/sessions/transcript-store.sqlite.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ContextEngine } from "../../context-engine/types.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { CURRENT_SESSION_VERSION } from "../transcript/session-transcript-contract.js";
import {
  resetCliCompactionTestDeps,
  runCliTurnCompactionLifecycle,
  setCliCompactionTestDeps,
} from "./cli-compaction.js";

function buildContextEngine(params: {
  compactCalls: Array<Parameters<ContextEngine["compact"]>[0]>;
}): ContextEngine {
  return {
    info: {
      id: "legacy",
      name: "Built-in Context Engine",
    },
    async ingest() {
      return { ingested: false };
    },
    async assemble(assembleParams) {
      return { messages: assembleParams.messages, estimatedTokens: 0 };
    },
    async compact(compactParams) {
      params.compactCalls.push(compactParams);
      return {
        ok: true,
        compacted: true,
        result: {
          summary: "compacted",
          tokensBefore: compactParams.currentTokenCount ?? 0,
          tokensAfter: 100,
        },
      };
    },
  };
}

function seedSqliteTranscript(params: { sessionId: string; cwd: string }) {
  replaceSqliteSessionTranscriptEvents({
    agentId: "main",
    sessionId: params.sessionId,
    events: [
      {
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: params.sessionId,
        timestamp: new Date(0).toISOString(),
        cwd: params.cwd,
      },
      {
        type: "message",
        id: "user-1",
        parentId: null,
        message: { role: "user", content: "old ask", timestamp: 1 },
        timestamp: new Date(1).toISOString(),
      },
      {
        type: "message",
        id: "assistant-1",
        parentId: "user-1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "old answer" }],
          timestamp: 2,
        },
        timestamp: new Date(2).toISOString(),
      },
    ],
  });
}

describe("runCliTurnCompactionLifecycle", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-compaction-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", tmpDir);
  });

  afterEach(async () => {
    resetCliCompactionTestDeps();
    closeOpenClawAgentDatabasesForTest();
    vi.unstubAllEnvs();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("compacts over-budget CLI transcripts and clears external CLI resume state", async () => {
    const sessionKey = "agent:main:cli";
    const sessionId = "session-cli";
    seedSqliteTranscript({ sessionId, cwd: tmpDir });

    const sessionEntry: SessionEntry = {
      sessionId,
      updatedAt: Date.now(),
      contextTokens: 1_000,
      totalTokens: 950,
      totalTokensFresh: true,
      cliSessionBindings: {
        "claude-cli": { sessionId: "claude-session" },
      },
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    upsertSessionEntry({ agentId: "main", sessionKey, entry: sessionEntry });

    const compactCalls: Array<Parameters<ContextEngine["compact"]>[0]> = [];
    const maintenance = vi.fn(async () => ({ changed: false, bytesFreed: 0, rewrittenEntries: 0 }));
    setCliCompactionTestDeps({
      resolveContextEngine: async () => buildContextEngine({ compactCalls }),
      createPreparedEmbeddedPiSettingsManager: async () => ({
        getCompactionReserveTokens: () => 200,
        getCompactionKeepRecentTokens: () => 0,
        applyOverrides: () => {},
      }),
      shouldPreemptivelyCompactBeforePrompt: () => ({
        route: "fits",
        shouldCompact: false,
        estimatedPromptTokens: 600,
        promptBudgetBeforeReserve: 800,
        overflowTokens: 0,
        toolResultReducibleChars: 0,
        effectiveReserveTokens: 200,
      }),
      resolveLiveToolResultMaxChars: () => 20_000,
      runContextEngineMaintenance: maintenance,
    });

    const updatedEntry = await runCliTurnCompactionLifecycle({
      cfg: {} as OpenClawConfig,
      sessionId,
      sessionKey,
      sessionEntry,
      sessionStore,
      sessionAgentId: "main",
      workspaceDir: tmpDir,
      agentDir: tmpDir,
      provider: "claude-cli",
      model: "opus",
    });

    expect(compactCalls).toHaveLength(1);
    expect(compactCalls[0]).toMatchObject({
      sessionId,
      sessionKey,
      tokenBudget: 1_000,
      currentTokenCount: 950,
      force: true,
      compactionTarget: "budget",
    });
    expect(maintenance).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "compaction",
        sessionId,
        sessionKey,
      }),
    );
    expect(updatedEntry?.compactionCount).toBe(1);
    expect(updatedEntry?.cliSessionBindings?.["claude-cli"]).toBeUndefined();
  });

  it("skips OpenClaw automatic CLI compaction for Codex runtime sessions", async () => {
    const sessionKey = "agent:main:codex";
    const sessionId = "session-codex";
    const sessionEntry: SessionEntry = {
      sessionId,
      updatedAt: Date.now(),
      contextTokens: 1_000,
      totalTokens: 950,
      totalTokensFresh: true,
      agentHarnessId: "codex",
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };

    const resolveContextEngine = vi.fn(async () => buildContextEngine({ compactCalls: [] }));
    const ensureSelectedAgentHarnessPlugin = vi.fn(async () => undefined);
    const compactAgentHarnessSession = vi.fn(async () => ({
      ok: true,
      compacted: true,
      result: { tokensBefore: 950, tokensAfter: 100 },
    }));
    const applyPiAutoCompactionGuard = vi.fn(async () => undefined);
    setCliCompactionTestDeps({
      resolveContextEngine,
      ensureSelectedAgentHarnessPlugin,
      maybeCompactAgentHarnessSession: compactAgentHarnessSession as never,
      applyPiAutoCompactionGuard,
    });

    const updatedEntry = await runCliTurnCompactionLifecycle({
      cfg: {} as OpenClawConfig,
      sessionId,
      sessionKey,
      sessionEntry,
      sessionStore,
      sessionAgentId: "main",
      workspaceDir: tmpDir,
      agentDir: tmpDir,
      provider: "openai",
      model: "gpt-5.5",
    });

    expect(resolveContextEngine).not.toHaveBeenCalled();
    expect(applyPiAutoCompactionGuard).not.toHaveBeenCalled();
    expect(ensureSelectedAgentHarnessPlugin).not.toHaveBeenCalled();
    expect(compactAgentHarnessSession).not.toHaveBeenCalled();
    expect(updatedEntry).toBe(sessionEntry);
  });

  it("routes matching native harness CLI compaction through the harness", async () => {
    const sessionKey = "agent:main:external-harness";
    const sessionId = "session-external-harness";
    seedSqliteTranscript({ sessionId, cwd: tmpDir });

    const sessionEntry: SessionEntry = {
      sessionId,
      updatedAt: Date.now(),
      contextTokens: 1_000,
      totalTokens: 950,
      totalTokensFresh: true,
      agentHarnessId: "external-harness",
    };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    upsertSessionEntry({ agentId: "main", sessionKey, entry: sessionEntry });

    const compactCalls: Array<Parameters<ContextEngine["compact"]>[0]> = [];
    const contextEngine = buildContextEngine({ compactCalls });
    const resolveContextEngine = vi.fn(async () => contextEngine);
    const ensureSelectedAgentHarnessPlugin = vi.fn(async () => undefined);
    const compactAgentHarnessSession = vi.fn(async () => ({
      ok: true,
      compacted: true,
      result: {
        summary: "native compacted",
        firstKeptEntryId: "kept-1",
        tokensBefore: 950,
        tokensAfter: 100,
        sessionId: "session-external-harness-next",
      },
    }));
    const applyPiAutoCompactionGuard = vi.fn(async () => undefined);
    setCliCompactionTestDeps({
      resolveContextEngine,
      ensureSelectedAgentHarnessPlugin,
      maybeCompactAgentHarnessSession: compactAgentHarnessSession as never,
      createPreparedEmbeddedPiSettingsManager: async () => ({
        getCompactionReserveTokens: () => 200,
        getCompactionKeepRecentTokens: () => 0,
        applyOverrides: () => {},
      }),
      shouldPreemptivelyCompactBeforePrompt: () => ({
        route: "fits",
        shouldCompact: false,
        estimatedPromptTokens: 600,
        promptBudgetBeforeReserve: 800,
        overflowTokens: 0,
        toolResultReducibleChars: 0,
        effectiveReserveTokens: 200,
      }),
      resolveLiveToolResultMaxChars: () => 20_000,
      applyPiAutoCompactionGuard,
    });

    const updatedEntry = await runCliTurnCompactionLifecycle({
      cfg: {} as OpenClawConfig,
      sessionId,
      sessionKey,
      sessionEntry,
      sessionStore,
      sessionAgentId: "main",
      workspaceDir: tmpDir,
      agentDir: tmpDir,
      provider: "external-harness",
      model: "model",
    });

    expect(resolveContextEngine).toHaveBeenCalledTimes(1);
    expect(applyPiAutoCompactionGuard).toHaveBeenCalledWith(
      expect.objectContaining({ contextEngineInfo: contextEngine.info }),
    );
    expect(ensureSelectedAgentHarnessPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "external-harness",
        modelId: "model",
        sessionKey,
        agentHarnessRuntimeOverride: "external-harness",
      }),
    );
    expect(compactAgentHarnessSession).toHaveBeenCalledTimes(1);
    expect(compactAgentHarnessSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        sessionKey,
        provider: "external-harness",
        model: "model",
        contextTokenBudget: 1_000,
        currentTokenCount: 950,
        contextEngine,
        agentHarnessId: "external-harness",
        trigger: "budget",
        force: true,
      }),
    );
    expect(compactCalls).toHaveLength(0);
    expect(updatedEntry).toMatchObject({
      sessionId: "session-external-harness-next",
      compactionCount: 1,
      totalTokens: 100,
      totalTokensFresh: true,
      usageFamilyKey: sessionKey,
    });
    expect(updatedEntry?.usageFamilySessionIds).toEqual([
      sessionId,
      "session-external-harness-next",
    ]);
  });

  it("initializes built-in context engines before resolving CLI compaction engine", async () => {
    const sessionKey = "agent:main:cli";
    const sessionId = "session-cli-init";
    seedSqliteTranscript({ sessionId, cwd: tmpDir });

    const sessionEntry: SessionEntry = {
      sessionId,
      updatedAt: Date.now(),
      contextTokens: 1_000,
      totalTokens: 950,
      totalTokensFresh: true,
    };
    const calls: string[] = [];
    setCliCompactionTestDeps({
      ensureContextEnginesInitialized: () => {
        calls.push("ensure");
      },
      resolveContextEngine: async () => {
        calls.push("resolve");
        return buildContextEngine({ compactCalls: [] });
      },
      createPreparedEmbeddedPiSettingsManager: async () => ({
        getCompactionReserveTokens: () => 200,
        getCompactionKeepRecentTokens: () => 0,
        applyOverrides: () => {},
      }),
      shouldPreemptivelyCompactBeforePrompt: () => ({
        route: "fits",
        shouldCompact: false,
        estimatedPromptTokens: 600,
        promptBudgetBeforeReserve: 800,
        overflowTokens: 0,
        toolResultReducibleChars: 0,
        effectiveReserveTokens: 200,
      }),
      resolveLiveToolResultMaxChars: () => 20_000,
    });

    await runCliTurnCompactionLifecycle({
      cfg: {} as OpenClawConfig,
      sessionId,
      sessionKey,
      sessionEntry,
      sessionAgentId: "main",
      workspaceDir: tmpDir,
      agentDir: tmpDir,
      provider: "claude-cli",
      model: "opus",
    });

    expect(calls).toEqual(["ensure", "resolve"]);
  });
});
