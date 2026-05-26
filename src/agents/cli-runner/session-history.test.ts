import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { replaceSqliteSessionTranscriptEvents } from "../../config/sessions/transcript-store.sqlite.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { CURRENT_SESSION_VERSION } from "../transcript/session-transcript-contract.js";
import {
  buildCliSessionHistoryPrompt,
  loadCliSessionHistoryMessages,
  loadCliSessionReseedMessages,
  MAX_CLI_SESSION_HISTORY_BYTES,
  MAX_CLI_SESSION_HISTORY_MESSAGES,
} from "./session-history.js";

function createSessionTranscript(params: {
  rootDir: string;
  sessionId: string;
  agentId?: string;
  messages?: string[];
}): void {
  const events: unknown[] = [
    {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: params.sessionId,
      timestamp: new Date(0).toISOString(),
      cwd: params.rootDir,
    },
  ];
  for (const [index, message] of (params.messages ?? []).entries()) {
    events.push({
      type: "message",
      id: `msg-${index}`,
      parentId: index > 0 ? `msg-${index - 1}` : null,
      timestamp: new Date(index + 1).toISOString(),
      message: {
        role: "user",
        content: message,
        timestamp: index + 1,
      },
    });
  }
  replaceSqliteSessionTranscriptEvents({
    agentId: params.agentId ?? "main",
    sessionId: params.sessionId,
    events,
    now: () => 1_770_000_000_000,
  });
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function expectMessageFields(value: unknown, expected: { role: string; content?: string }) {
  const message = requireRecord(value, "message");
  expect(message.role).toBe(expected.role);
  if ("content" in expected) {
    expect(message.content).toBe(expected.content);
  }
}

function expectCompactionSummary(value: unknown, summary: string) {
  const message = requireRecord(value, "compaction summary");
  expect(message.role).toBe("compactionSummary");
  expect(message.summary).toBe(summary);
}

function appendSessionTranscriptEvents(params: {
  sessionId: string;
  agentId?: string;
  events: unknown[];
}): void {
  replaceSqliteSessionTranscriptEvents({
    agentId: params.agentId ?? "main",
    sessionId: params.sessionId,
    events: params.events,
    now: () => 1_770_000_000_000,
  });
}

function createSessionTranscriptEvents(params: {
  rootDir: string;
  sessionId: string;
  messages?: string[];
}) {
  return [
    {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: params.sessionId,
      timestamp: new Date(0).toISOString(),
      cwd: params.rootDir,
    },
    ...(params.messages ?? []).map((message, index) => ({
      type: "message",
      id: `msg-${index}`,
      parentId: index > 0 ? `msg-${index - 1}` : null,
      timestamp: new Date(index + 1).toISOString(),
      message: {
        role: "user",
        content: message,
        timestamp: index + 1,
      },
    })),
  ];
}

describe("loadCliSessionHistoryMessages", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
  });

  it("reads the canonical SQLite transcript for the requested session", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    createSessionTranscript({
      rootDir: stateDir,
      sessionId: "session-test",
      messages: ["expected history"],
    });

    try {
      expect(
        await loadCliSessionHistoryMessages({
          sessionId: "session-test",
          sessionKey: "agent:main:main",
          agentId: "main",
        }),
      ).toMatchObject([{ role: "user", content: "expected history" }]);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("keeps only the newest bounded history window", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    createSessionTranscript({
      rootDir: stateDir,
      sessionId: "session-bounded",
      messages: Array.from(
        { length: MAX_CLI_SESSION_HISTORY_MESSAGES + 25 },
        (_, index) => `msg-${index}`,
      ),
    });

    try {
      const history = await loadCliSessionHistoryMessages({
        sessionId: "session-bounded",
        sessionKey: "agent:main:main",
        agentId: "main",
      });
      expect(history).toHaveLength(MAX_CLI_SESSION_HISTORY_MESSAGES);
      expectMessageFields(history[0], { role: "user", content: "msg-25" });
      expectMessageFields(history.at(-1), {
        role: "user",
        content: `msg-${MAX_CLI_SESSION_HISTORY_MESSAGES + 24}`,
      });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("ignores transcripts owned by a different agent", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-outside-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    createSessionTranscript({
      rootDir: outsideDir,
      sessionId: "session-symlink",
      agentId: "other",
      messages: ["stolen history"],
    });
    try {
      expect(
        await loadCliSessionHistoryMessages({
          sessionId: "session-symlink",
          sessionKey: "agent:main:main",
          agentId: "main",
        }),
      ).toEqual([]);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("drops oversized SQLite transcripts instead of loading them into hook payloads", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    createSessionTranscript({
      rootDir: stateDir,
      sessionId: "session-oversized",
      messages: ["x".repeat(MAX_CLI_SESSION_HISTORY_BYTES + 1)],
    });

    try {
      expect(
        await loadCliSessionHistoryMessages({
          sessionId: "session-oversized",
          sessionKey: "agent:main:main",
          agentId: "main",
        }),
      ).toEqual([]);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("reads transcript rows from the configured state database", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    createSessionTranscript({
      rootDir: stateDir,
      sessionId: "session-custom-store",
      messages: ["custom store history"],
    });

    try {
      expect(
        await loadCliSessionHistoryMessages({
          sessionId: "session-custom-store",
          sessionKey: "agent:main:main",
          agentId: "main",
          config: {
            session: {},
          },
        }),
      ).toMatchObject([{ role: "user", content: "custom store history" }]);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe("loadCliSessionReseedMessages", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
  });

  it("does not reseed fresh CLI sessions from raw transcript history before compaction", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    createSessionTranscript({
      rootDir: stateDir,
      sessionId: "session-no-compaction",
      messages: ["raw secret", "large context"],
    });

    try {
      expect(
        await loadCliSessionReseedMessages({
          sessionId: "session-no-compaction",
          sessionKey: "agent:main:main",
          agentId: "main",
        }),
      ).toEqual([]);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("reseeds safe invalidated sessions from a bounded raw message tail when explicitly opted in", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    createSessionTranscript({
      rootDir: stateDir,
      sessionId: "session-opt-in-raw-tail",
      messages: Array.from(
        { length: MAX_CLI_SESSION_HISTORY_MESSAGES + 25 },
        (_, index) => `raw-${index}`,
      ),
    });

    try {
      const reseed = await loadCliSessionReseedMessages({
        sessionId: "session-opt-in-raw-tail",
        sessionKey: "agent:main:main",
        agentId: "main",
        allowRawTranscriptReseed: true,
        rawTranscriptReseedReason: "missing-transcript",
      });
      expect(reseed).toHaveLength(MAX_CLI_SESSION_HISTORY_MESSAGES);
      expectMessageFields(reseed[0], { role: "user", content: "raw-25" });
      expectMessageFields(reseed.at(-1), {
        role: "user",
        content: `raw-${MAX_CLI_SESSION_HISTORY_MESSAGES + 24}`,
      });
      expect(buildCliSessionHistoryPrompt({ messages: reseed, prompt: "next" })).toContain(
        "raw-25",
      );
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("does not raw-reseed auth-boundary invalidations even when opted in", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    createSessionTranscript({
      rootDir: stateDir,
      sessionId: "session-auth-boundary",
      messages: ["previous account context"],
    });

    try {
      await expect(
        loadCliSessionReseedMessages({
          sessionId: "session-auth-boundary",
          sessionKey: "agent:main:main",
          agentId: "main",
          allowRawTranscriptReseed: true,
          rawTranscriptReseedReason: "auth-profile",
        }),
      ).resolves.toStrictEqual([]);
      await expect(
        loadCliSessionReseedMessages({
          sessionId: "session-auth-boundary",
          sessionKey: "agent:main:main",
          agentId: "main",
          allowRawTranscriptReseed: true,
          rawTranscriptReseedReason: "auth-epoch",
        }),
      ).resolves.toStrictEqual([]);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("reseeds fresh CLI sessions from the latest compaction summary and post-compaction tail", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-state-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    createSessionTranscript({
      rootDir: stateDir,
      sessionId: "session-compacted",
      messages: ["pre-compaction raw history"],
    });
    appendSessionTranscriptEvents({
      sessionId: "session-compacted",
      events: [
        ...createSessionTranscriptEvents({
          rootDir: stateDir,
          sessionId: "session-compacted",
          messages: ["pre-compaction raw history"],
        }),
        {
          type: "compaction",
          id: "compaction-1",
          parentId: "msg-0",
          timestamp: new Date(2).toISOString(),
          summary: "safe compacted summary",
          firstKeptEntryId: "msg-0",
          tokensBefore: 10_000,
        },
        {
          type: "message",
          id: "msg-1",
          parentId: "compaction-1",
          timestamp: new Date(3).toISOString(),
          message: {
            role: "user",
            content: "post-compaction ask",
            timestamp: 3,
          },
        },
      ],
    });

    try {
      const reseed = await loadCliSessionReseedMessages({
        sessionId: "session-compacted",
        sessionKey: "agent:main:main",
        agentId: "main",
      });
      expect(reseed).toHaveLength(2);
      expectCompactionSummary(reseed[0], "safe compacted summary");
      expectMessageFields(reseed[1], { role: "user", content: "post-compaction ask" });
      expect(buildCliSessionHistoryPrompt({ messages: reseed, prompt: "next" })).toContain(
        "Compaction summary: safe compacted summary",
      );
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe("buildCliSessionHistoryPrompt", () => {
  it("renders OpenClaw transcript history around the next user message", () => {
    const prompt = buildCliSessionHistoryPrompt({
      messages: [
        { role: "user", content: "old ask" },
        { role: "assistant", content: [{ type: "text", text: "old answer" }] },
      ],
      prompt: "new ask",
    });

    expect(prompt).toContain("User: old ask");
    expect(prompt).toContain("Assistant: old answer");
    expect(prompt).toContain("<next_user_message>\nnew ask\n</next_user_message>");
  });

  it("skips reseed text when the transcript has no renderable conversation", () => {
    expect(
      buildCliSessionHistoryPrompt({
        messages: [{ role: "tool", content: "ignored" }],
        prompt: "new ask",
      }),
    ).toBeUndefined();
  });

  it("caps rendered reseed history before adding the next user message", () => {
    const prompt = buildCliSessionHistoryPrompt({
      messages: [
        { role: "user", content: "x".repeat(100) },
        { role: "assistant", content: "y".repeat(100) },
      ],
      prompt: "current ask must survive",
      maxHistoryChars: 20,
    });

    expect(prompt).toContain("[OpenClaw reseed history truncated; older turns dropped]");
    expect(prompt).toContain("<next_user_message>\ncurrent ask must survive\n</next_user_message>");
    // Older 100-char prefix must be dropped by the tail slice; the
    // post-cap rendered tail is shorter than the dropped prefix.
    expect(prompt).not.toContain("x".repeat(80));
  });

  it("keeps the most recent turns when rendered history exceeds the cap", () => {
    // Older turns plus a final marker turn whose content is exactly what a
    // head-slice would drop first. Asserting the marker survives in the
    // rendered prompt locks in tail-slice semantics: a session-recovery
    // feature must keep the latest context, not the oldest.
    const prompt = buildCliSessionHistoryPrompt({
      messages: [
        { role: "user", content: "x".repeat(8000) },
        { role: "assistant", content: "y".repeat(8000) },
        { role: "user", content: "FINAL_USER_MARKER" },
        { role: "assistant", content: "FINAL_ASSISTANT_MARKER" },
      ],
      prompt: "next ask",
    });

    expect(prompt).toBeDefined();
    expect(prompt).toContain("FINAL_USER_MARKER");
    expect(prompt).toContain("FINAL_ASSISTANT_MARKER");
    expect(prompt).toContain("[OpenClaw reseed history truncated; older turns dropped]");
    // The oldest 8000-char block must have been dropped — a head-slice
    // would have kept it instead of the recent tail.
    expect(prompt).not.toContain("x".repeat(8000));
    expect(prompt).toContain("<next_user_message>\nnext ask\n</next_user_message>");
  });

  it("preserves the compaction summary when the post-summary transcript exceeds the cap", () => {
    // loadCliSessionReseedMessages places a compactionSummary entry first
    // so the compacted prior context survives reseed. A blind tail slice
    // of the joined history would drop that summary whenever the
    // post-summary tail alone exceeds the cap. The structure-aware
    // truncation pins the summary as a prefix and caps only the tail.
    const prompt = buildCliSessionHistoryPrompt({
      messages: [
        { role: "compactionSummary", summary: "COMPACTION_SUMMARY_MARKER pinned context" },
        { role: "user", content: "z".repeat(8000) },
        { role: "assistant", content: "w".repeat(8000) },
        { role: "user", content: "POST_SUMMARY_FINAL_USER" },
        { role: "assistant", content: "POST_SUMMARY_FINAL_ASSISTANT" },
      ],
      prompt: "next ask",
    });

    expect(prompt).toBeDefined();
    // Compaction summary must be pinned as a prefix, not sliced away.
    expect(prompt).toContain("Compaction summary: COMPACTION_SUMMARY_MARKER pinned context");
    // Recent tail still preserved within the post-summary budget.
    expect(prompt).toContain("POST_SUMMARY_FINAL_USER");
    expect(prompt).toContain("POST_SUMMARY_FINAL_ASSISTANT");
    expect(prompt).toContain("[OpenClaw reseed history truncated; older turns dropped]");
    // Head of post-summary tail (oldest 8000-char `z` block) must be
    // dropped so the cap is honored.
    expect(prompt).not.toContain("z".repeat(8000));
    expect(prompt).toContain("<next_user_message>\nnext ask\n</next_user_message>");
  });

  it("caps oversize compaction summary while preserving recent post-summary tail", () => {
    // Two regressions covered here:
    // 1. `tailRaw.slice(-0)` would return the entire tail (JS quirk:
    //    `String.prototype.slice(-0) === slice(0)`), defeating the cap when
    //    the summary block consumes the budget.
    // 2. Pinning the full summary as-is when the summary itself exceeds
    //    `maxHistoryChars` would blow past the cap that prevents
    //    reseeding fresh CLI sessions with unexpectedly huge prompts.
    //    The summary must itself be truncated to fit the budget while still
    //    preserving the recent post-summary exact turns.
    const summaryText = "OVERSIZE_SUMMARY_MARKER ".repeat(50).trim();
    const maxHistoryChars = 200;
    const prompt = buildCliSessionHistoryPrompt({
      messages: [
        { role: "compactionSummary", summary: summaryText },
        { role: "user", content: "POST_SUMMARY_USER_DROPPED" },
        { role: "assistant", content: "POST_SUMMARY_ASSISTANT_DROPPED" },
      ],
      prompt: "next ask",
      // Cap well below the rendered summary block so the summary itself
      // must be truncated and the tail budget would naively be 0.
      maxHistoryChars,
    });

    expect(prompt).toBeDefined();
    // The truncated summary still leads with recognizable load-bearing
    // text — head-slicing preserves the orientation/intro of the summary.
    expect(prompt).toContain("OVERSIZE_SUMMARY_MARKER");
    expect(prompt).toContain("Compaction summary:");
    // The leading truncation marker is present so the prompt announces
    // what was discarded.
    expect(prompt).toContain("[OpenClaw reseed history truncated; older turns dropped]");
    // The cap is honored: the rendered <conversation_history> block
    // must not blow past `maxHistoryChars` plus a small wrapper allowance.
    const historyMatch = prompt?.match(
      /<conversation_history>\n([\s\S]*?)\n<\/conversation_history>/,
    );
    expect(historyMatch).not.toBeNull();
    const renderedHistory = historyMatch?.[1] ?? "";
    expect(renderedHistory.length).toBeLessThanOrEqual(maxHistoryChars);
    // The full untruncated summary must NOT appear — that would defeat
    // the cap.
    expect(prompt).not.toContain(summaryText);
    // Post-summary exact turns are newer than the summary and must still
    // survive inside the reserved tail budget.
    expect(prompt).toContain("POST_SUMMARY_USER_DROPPED");
    expect(prompt).toContain("POST_SUMMARY_ASSISTANT_DROPPED");
    expect(prompt).toContain("<next_user_message>\nnext ask\n</next_user_message>");
  });

  it("honors the cap when the summary block plus marker crosses it", () => {
    // Edge case: `summaryRendered.length < maxHistoryChars` (the gate that
    // routes to the oversize-summary branch is not taken) BUT
    // `summaryBlock.length >= maxHistoryChars` once the `\n\n` separator
    // is appended, making `remainingBudget <= 0`. Without summary
    // truncation in that branch, the rendered history block is
    // `summary + separator + marker` — well over `maxHistoryChars`. A
    // 199-char rendered summary under a 200-char cap would otherwise
    // produce a 257-char history block.
    const maxHistoryChars = 200;
    // `renderHistoryMessage` prefixes "Compaction summary: " (20 chars)
    // before the summary text, so a 179-char summary renders to 199 chars
    // — strictly less than the cap, but `summaryBlock = rendered + "\n\n"`
    // is 201 chars and `remainingBudget` is negative.
    const summaryPrefix = "Compaction summary: ";
    const summaryText = "S".repeat(maxHistoryChars - 1 - summaryPrefix.length);
    const prompt = buildCliSessionHistoryPrompt({
      messages: [
        { role: "compactionSummary", summary: summaryText },
        { role: "user", content: "POST_SUMMARY_TAIL_USER" },
        { role: "assistant", content: "POST_SUMMARY_TAIL_ASSISTANT" },
      ],
      prompt: "next ask",
      maxHistoryChars,
    });

    expect(prompt).toBeDefined();
    const historyMatch = prompt?.match(
      /<conversation_history>\n([\s\S]*?)\n<\/conversation_history>/,
    );
    expect(historyMatch).not.toBeNull();
    const renderedHistory = historyMatch?.[1] ?? "";
    expect(renderedHistory.length).toBeLessThanOrEqual(maxHistoryChars);
    // Marker is still present so the prompt announces what was discarded.
    expect(prompt).toContain("[OpenClaw reseed history truncated; older turns dropped]");
    // Near-cap summaries still reserve room for the newest exact turns.
    expect(prompt).toContain("POST_SUMMARY_TAIL_USER");
    expect(prompt).toContain("POST_SUMMARY_TAIL_ASSISTANT");
  });
});
