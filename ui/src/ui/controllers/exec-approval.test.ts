import { describe, expect, it, vi } from "vitest";
import {
  getDismissedExecApprovalQueue,
  getVisibleExecApprovalQueue,
  hideActiveExecApprovalPrompt,
  isStaleApprovalResolutionError,
  parseExecApprovalRequested,
  parsePluginApprovalRequested,
  clearResolvedExecApprovalPrompt,
  refreshPendingApprovalQueue,
  resolveActiveExecApprovalDecision,
  showExecApprovalPrompt,
  type ExecApprovalPromptState,
  type ExecApprovalRequest,
} from "./exec-approval.ts";

type RequestFn = (method: string, params?: unknown) => Promise<unknown>;

function createExecApproval(overrides: Partial<ExecApprovalRequest> = {}): ExecApprovalRequest {
  return {
    id: "approval-1",
    kind: "exec",
    request: { command: "echo hello" },
    createdAtMs: 1000,
    expiresAtMs: Date.now() + 60_000,
    ...overrides,
  };
}

function createPromptState(
  request: RequestFn,
  queue: ExecApprovalRequest[] = [createExecApproval()],
): ExecApprovalPromptState {
  return {
    client: { request },
    execApprovalQueue: queue,
    execApprovalDismissedIds: new Set(),
    execApprovalBusy: false,
    execApprovalError: null,
  };
}

function createGatewayError(message: string, details?: unknown): Error {
  const err = new Error(message);
  Object.defineProperty(err, "gatewayCode", {
    value: "INVALID_REQUEST",
    enumerable: true,
  });
  Object.defineProperty(err, "details", {
    value: details,
    enumerable: true,
  });
  return err;
}

describe("parseExecApprovalRequested", () => {
  it("returns entries with kind 'exec'", () => {
    const result = parseExecApprovalRequested({
      id: "exec-1",
      request: { command: "rm -rf /" },
      createdAtMs: 1000,
      expiresAtMs: 2000,
    });
    expect(result?.kind).toBe("exec");
    expect(result?.request.command).toBe("rm -rf /");
  });
});

describe("parsePluginApprovalRequested", () => {
  // Matches the actual gateway broadcast shape: title/description/severity/pluginId
  // are nested inside payload.request (PluginApprovalRequestPayload)
  const validPayload = {
    id: "plugin-1",
    createdAtMs: 1000,
    expiresAtMs: 120_000,
    request: {
      title: "Dangerous command detected",
      description: "chmod 777 script.sh modifies file permissions",
      severity: "high",
      pluginId: "sage",
      agentId: "agent-1",
      sessionKey: "sess-1",
    },
  };

  it("parses a valid payload", () => {
    const result = parsePluginApprovalRequested(validPayload);
    expect(result?.kind).toBe("plugin");
    expect(result?.pluginTitle).toBe("Dangerous command detected");
    expect(result?.pluginDescription).toBe("chmod 777 script.sh modifies file permissions");
    expect(result?.pluginSeverity).toBe("high");
    expect(result?.pluginId).toBe("sage");
    expect(result?.request.command).toBe("Dangerous command detected");
    expect(result?.request.agentId).toBe("agent-1");
    expect(result?.request.sessionKey).toBe("sess-1");
    expect(result?.createdAtMs).toBe(1000);
    expect(result?.expiresAtMs).toBe(120_000);
  });

  it("returns null when title is missing from request", () => {
    const {
      request: { title: _, ...restRequest },
      ...rest
    } = validPayload;
    expect(parsePluginApprovalRequested({ ...rest, request: restRequest })).toBeNull();
  });

  it("returns null when request is missing entirely", () => {
    const { request: _, ...noRequest } = validPayload;
    expect(parsePluginApprovalRequested(noRequest)).toBeNull();
  });

  it("returns null when id is missing", () => {
    const { id: _, ...noId } = validPayload;
    expect(parsePluginApprovalRequested(noId)).toBeNull();
  });

  it("returns null when timestamps are missing", () => {
    const { createdAtMs: _, expiresAtMs: __, ...noTimestamps } = validPayload;
    expect(parsePluginApprovalRequested(noTimestamps)).toBeNull();
  });

  it("returns null for null payload", () => {
    expect(parsePluginApprovalRequested(null)).toBeNull();
  });

  it("returns null for non-object payload", () => {
    expect(parsePluginApprovalRequested("not an object")).toBeNull();
  });

  it("handles missing optional fields gracefully", () => {
    const minimal = {
      id: "plugin-2",
      createdAtMs: 500,
      expiresAtMs: 60_000,
      request: { title: "Alert" },
    };
    const result = parsePluginApprovalRequested(minimal);
    expect(result?.kind).toBe("plugin");
    expect(result?.pluginTitle).toBe("Alert");
    expect(result?.pluginDescription).toBeNull();
    expect(result?.pluginSeverity).toBeNull();
    expect(result?.pluginId).toBeNull();
    expect(result?.request.agentId).toBeNull();
    expect(result?.request.sessionKey).toBeNull();
  });
});

describe("parseExecApprovalRequested command spans", () => {
  it("preserves command text spacing for span offsets", () => {
    const parsed = parseExecApprovalRequested({
      id: "approval-spaces-1",
      request: { command: "  python -c 'print(1)'" },
      createdAtMs: 1,
      expiresAtMs: 2,
    });

    expect(parsed?.request.command).toBe("  python -c 'print(1)'");
  });

  it("rejects whitespace-only command text", () => {
    expect(
      parseExecApprovalRequested({
        id: "approval-blank-1",
        request: { command: "   " },
        createdAtMs: 1,
        expiresAtMs: 2,
      }),
    ).toBeNull();
  });

  it("preserves valid command spans from exec approval events", () => {
    const parsed = parseExecApprovalRequested({
      id: "approval-explain-1",
      request: {
        command: "ls | grep stuff",
        commandSpans: [
          { startIndex: 0, endIndex: 2 },
          { startIndex: 5, endIndex: 9 },
          { startIndex: 10, endIndex: 15 },
          { startIndex: 16, endIndex: 20 },
          { startIndex: -1, endIndex: 2 },
          { startIndex: 8, endIndex: 8 },
        ],
      },
      createdAtMs: 1,
      expiresAtMs: 2,
    });

    expect(parsed?.request.commandSpans).toEqual([
      { startIndex: 0, endIndex: 2 },
      { startIndex: 5, endIndex: 9 },
      { startIndex: 10, endIndex: 15 },
    ]);
  });
});

describe("isStaleApprovalResolutionError", () => {
  it("detects already-resolved approval errors", () => {
    expect(
      isStaleApprovalResolutionError(
        createGatewayError("approval already resolved", {
          reason: "APPROVAL_ALREADY_RESOLVED",
        }),
      ),
    ).toBe(true);
  });

  it("detects unknown or expired approval errors", () => {
    expect(
      isStaleApprovalResolutionError(createGatewayError("unknown or expired approval id")),
    ).toBe(true);
  });

  it("ignores unrelated approval resolve errors", () => {
    expect(isStaleApprovalResolutionError(createGatewayError("gateway unavailable"))).toBe(false);
  });
});

describe("resolveActiveExecApprovalDecision", () => {
  it("dismisses the active approval after same-decision idempotent success", async () => {
    const request = vi.fn<RequestFn>(async () => ({ ok: true }));
    const state = createPromptState(request);

    await resolveActiveExecApprovalDecision(state, "allow-once");

    expect(request).toHaveBeenCalledWith("exec.approval.resolve", {
      id: "approval-1",
      decision: "allow-once",
    });
    expect(state.execApprovalQueue).toEqual([]);
    expect(state.execApprovalError).toBeNull();
    expect(state.execApprovalBusy).toBe(false);
  });

  it("resolves the first visible approval when an earlier one is dismissed", async () => {
    const request = vi.fn<RequestFn>(async () => ({ ok: true }));
    const hidden = createExecApproval({ id: "approval-hidden", createdAtMs: 1 });
    const visible = createExecApproval({ id: "approval-visible", createdAtMs: 2 });
    const state = createPromptState(request, [hidden, visible]);
    state.execApprovalDismissedIds = new Set(["approval-hidden"]);

    await resolveActiveExecApprovalDecision(state, "deny");

    expect(request).toHaveBeenCalledWith("exec.approval.resolve", {
      id: "approval-visible",
      decision: "deny",
    });
    expect(state.execApprovalQueue.map((entry) => entry.id)).toEqual(["approval-hidden"]);
    expect(state.execApprovalDismissedIds).toEqual(new Set(["approval-hidden"]));
  });

  it("dismisses and refreshes when the backend reports an already resolved approval", async () => {
    const request = vi.fn<RequestFn>(async (method) => {
      if (method === "exec.approval.resolve") {
        throw createGatewayError("approval already resolved", {
          reason: "APPROVAL_ALREADY_RESOLVED",
        });
      }
      if (method === "exec.approval.list") {
        return [];
      }
      if (method === "plugin.approval.list") {
        return [];
      }
      return {};
    });
    const state = createPromptState(request);

    await resolveActiveExecApprovalDecision(state, "deny");

    expect(state.execApprovalQueue).toEqual([]);
    expect(state.execApprovalError).toBeNull();
    expect(state.execApprovalBusy).toBe(false);
    expect(request).toHaveBeenCalledWith("exec.approval.list", {});
    expect(request).toHaveBeenCalledWith("plugin.approval.list", {});
  });

  it("keeps the active approval open for unrelated errors", async () => {
    const request = vi.fn<RequestFn>(async () => {
      throw createGatewayError("gateway unavailable");
    });
    const active = createExecApproval();
    const state = createPromptState(request, [active]);

    await resolveActiveExecApprovalDecision(state, "deny");

    expect(state.execApprovalQueue).toEqual([active]);
    expect(state.execApprovalError).toBe("Approval failed: Error: gateway unavailable");
    expect(state.execApprovalBusy).toBe(false);
  });

  it("does not show unrelated resolve errors after the active prompt was dismissed", async () => {
    const request = vi.fn<RequestFn>(async () => {
      throw createGatewayError("gateway unavailable");
    });
    const active = createExecApproval();
    const state = createPromptState(request, [active]);
    const resolvePromise = resolveActiveExecApprovalDecision(state, "deny");

    hideActiveExecApprovalPrompt(state);
    await resolvePromise;

    expect(state.execApprovalQueue).toEqual([active]);
    expect(state.execApprovalDismissedIds).toEqual(new Set(["approval-1"]));
    expect(state.execApprovalError).toBeNull();
    expect(state.execApprovalBusy).toBe(false);
  });
});

describe("clearResolvedExecApprovalPrompt", () => {
  it("does not clear the visible prompt error when a hidden approval resolves", () => {
    const hidden = createExecApproval({ id: "approval-hidden", createdAtMs: 1 });
    const visible = createExecApproval({ id: "approval-visible", createdAtMs: 2 });
    const state = createPromptState(
      vi.fn<RequestFn>(async () => ({})),
      [hidden, visible],
    );
    state.execApprovalDismissedIds = new Set(["approval-hidden"]);
    state.execApprovalError = "Approval failed: Error: gateway unavailable";

    clearResolvedExecApprovalPrompt(state, "approval-hidden");

    expect(state.execApprovalQueue.map((entry) => entry.id)).toEqual(["approval-visible"]);
    expect(state.execApprovalDismissedIds).toEqual(new Set());
    expect(state.execApprovalError).toBe("Approval failed: Error: gateway unavailable");
  });
});

describe("hideActiveExecApprovalPrompt", () => {
  it("hides the active approval without removing it from the pending queue", () => {
    const state = createPromptState(vi.fn<RequestFn>(async () => ({})));

    hideActiveExecApprovalPrompt(state);

    expect(state.execApprovalQueue.map((entry) => entry.id)).toEqual(["approval-1"]);
    expect(state.execApprovalDismissedIds).toEqual(new Set(["approval-1"]));
    expect(getVisibleExecApprovalQueue(state)).toEqual([]);
    expect(getDismissedExecApprovalQueue(state).map((entry) => entry.id)).toEqual(["approval-1"]);
    expect(state.execApprovalError).toBeNull();
  });
});

describe("showExecApprovalPrompt", () => {
  it("restores a dismissed pending approval to the visible queue", () => {
    const state = createPromptState(vi.fn<RequestFn>(async () => ({})));
    hideActiveExecApprovalPrompt(state);

    showExecApprovalPrompt(state, "approval-1");

    expect(state.execApprovalDismissedIds).toEqual(new Set());
    expect(getVisibleExecApprovalQueue(state).map((entry) => entry.id)).toEqual(["approval-1"]);
    expect(getDismissedExecApprovalQueue(state)).toEqual([]);
  });
});

describe("refreshPendingApprovalQueue", () => {
  it("removes refreshed approvals after their expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-25T00:00:00.000Z"));
    try {
      const expiresAtMs = Date.now() + 1_000;
      const request = vi.fn<RequestFn>(async (method) => {
        if (method === "exec.approval.list") {
          return [
            {
              id: "approval-refreshed-1",
              request: { command: "pnpm check:changed" },
              createdAtMs: Date.now(),
              expiresAtMs,
            },
          ];
        }
        if (method === "plugin.approval.list") {
          return [];
        }
        return {};
      });
      const state = createPromptState(request, []);

      await refreshPendingApprovalQueue(state);
      expect(state.execApprovalQueue.map((entry) => entry.id)).toEqual(["approval-refreshed-1"]);

      vi.advanceTimersByTime(1_500);

      expect(state.execApprovalQueue).toEqual([]);
      expect(state.execApprovalDismissedIds).toEqual(new Set());
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves dismissed refreshed approvals while they remain pending", async () => {
    const request = vi.fn<RequestFn>(async (method) => {
      if (method === "exec.approval.list") {
        return [
          {
            id: "approval-hidden",
            request: { command: "pnpm check:changed" },
            createdAtMs: Date.now(),
            expiresAtMs: Date.now() + 60_000,
          },
        ];
      }
      if (method === "plugin.approval.list") {
        return [];
      }
      return {};
    });
    const state = createPromptState(request, []);
    state.execApprovalDismissedIds = new Set(["approval-hidden", "approval-gone"]);

    await refreshPendingApprovalQueue(state);

    expect(state.execApprovalQueue.map((entry) => entry.id)).toEqual(["approval-hidden"]);
    expect(state.execApprovalDismissedIds).toEqual(new Set(["approval-hidden"]));
    expect(getVisibleExecApprovalQueue(state)).toEqual([]);
  });
});
