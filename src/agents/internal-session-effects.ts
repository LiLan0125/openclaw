import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { deleteSqliteSessionTranscript } from "../config/sessions/transcript-store.sqlite.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { listOpenClawRegisteredAgentDatabases } from "../state/openclaw-agent-db.js";

const INTERNAL_SESSION_EFFECTS_AGENT_ID = "main";

function normalizeInternalRunId(runId: string): string {
  return runId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "run";
}

export type InternalSessionEffectsTranscriptScope = {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  transcriptFile: string;
};

export function resolveInternalSessionEffectsTranscriptPath(runId: string): string {
  const safeRunId = normalizeInternalRunId(runId);
  return path.join(resolveStateDir(), "internal-agent-runs", `${safeRunId}.jsonl`);
}

export function resolveInternalSessionEffectsTranscriptScope(params: {
  agentId?: string;
  runId: string;
}): InternalSessionEffectsTranscriptScope {
  const safeRunId = normalizeInternalRunId(params.runId);
  const agentId = normalizeAgentId(params.agentId ?? INTERNAL_SESSION_EFFECTS_AGENT_ID);
  const sessionId = `internal-agent-run:${safeRunId}`;
  return {
    agentId,
    sessionId,
    sessionKey: sessionId,
    transcriptFile: resolveInternalSessionEffectsTranscriptPath(params.runId),
  };
}

export function resolveInternalSessionEffectsTranscriptScopeFromPath(
  sessionFile: string | undefined,
): InternalSessionEffectsTranscriptScope | undefined {
  const dir = path.join(resolveStateDir(), "internal-agent-runs");
  const resolved = sessionFile ? path.resolve(sessionFile) : "";
  if (!resolved || path.dirname(resolved) !== path.resolve(dir)) {
    return undefined;
  }
  const basename = path.basename(resolved);
  if (!basename.endsWith(".jsonl")) {
    return undefined;
  }
  return resolveInternalSessionEffectsTranscriptScope({
    runId: basename.slice(0, -".jsonl".length),
  });
}

export async function prepareInternalSessionEffectsTranscriptScope(params: {
  agentId?: string;
  runId: string;
}): Promise<InternalSessionEffectsTranscriptScope> {
  return resolveInternalSessionEffectsTranscriptScope(params);
}

export async function prepareInternalSessionEffectsTranscript(params: {
  sessionFile?: string;
  runId: string;
}): Promise<string> {
  // Callers must persist this path in an owning lifecycle record and invoke
  // removeInternalSessionEffectsTranscript once the recovered output is no longer needed.
  const sessionFile = resolveInternalSessionEffectsTranscriptPath(params.runId);
  await fs.mkdir(path.dirname(sessionFile), { recursive: true, mode: 0o700 });
  if (!params.sessionFile) {
    await fs.writeFile(sessionFile, "", { mode: 0o600 });
    await fs.chmod(sessionFile, 0o600);
    return sessionFile;
  }
  try {
    const contents = await fs.readFile(params.sessionFile);
    await fs.writeFile(sessionFile, contents, { mode: 0o600 });
    await fs.chmod(sessionFile, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    await fs.writeFile(sessionFile, "", { mode: 0o600 });
    await fs.chmod(sessionFile, 0o600);
  }
  return sessionFile;
}

export async function removeInternalSessionEffectsTranscript(
  sessionFile: string | undefined,
): Promise<void> {
  const scope = resolveInternalSessionEffectsTranscriptScopeFromPath(sessionFile);
  if (scope) {
    const targets = [
      { agentId: scope.agentId, path: undefined as string | undefined },
      ...listOpenClawRegisteredAgentDatabases().map((target) => ({
        agentId: target.agentId,
        path: target.path,
      })),
    ];
    const seen = new Set<string>();
    for (const target of targets) {
      const key = `${target.agentId}\0${target.path ?? ""}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      try {
        deleteSqliteSessionTranscript({
          agentId: target.agentId,
          ...(target.path ? { path: target.path } : {}),
          sessionId: scope.sessionId,
        });
      } catch {
        // Best-effort cleanup; callers should not fail on stale or already-removed scopes.
      }
    }
  }
  const dir = path.join(resolveStateDir(), "internal-agent-runs");
  const resolved = sessionFile ? path.resolve(sessionFile) : "";
  if (!resolved || path.dirname(resolved) !== path.resolve(dir)) {
    return;
  }
  try {
    await fs.rm(resolved, { force: true });
  } catch {
    // Best-effort privacy/disk cleanup; run cleanup must not fail on temp-file races.
  }
}
