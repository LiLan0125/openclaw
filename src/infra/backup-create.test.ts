import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";
import { backupVerifyCommand } from "../commands/backup-verify.js";
import type { RuntimeEnv } from "../runtime.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  testApi as backupCreateInternals,
  buildExtensionsNodeModulesFilter,
  createBackupArchive,
  formatBackupCreateSummary,
  type BackupCreateResult,
} from "./backup-create.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { requireNodeSqlite } from "./node-sqlite.js";

function makeResult(overrides: Partial<BackupCreateResult> = {}): BackupCreateResult {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    archiveRoot: "openclaw-backup-2026-01-01",
    archivePath: "/tmp/openclaw-backup.tar.gz",
    dryRun: false,
    includeWorkspace: true,
    onlyConfig: false,
    verified: false,
    assets: [],
    skipped: [],
    skippedVolatileCount: 0,
    ...overrides,
  };
}

type BackupCreateTestDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "diagnostic_events" | "backup_runs" | "delivery_queue_entries"
>;

async function listArchiveEntries(archivePath: string): Promise<string[]> {
  const entries: string[] = [];
  await tar.t({
    file: archivePath,
    gzip: true,
    onentry: (entry) => {
      entries.push(entry.path);
      entry.resume();
    },
  });
  return entries;
}

async function listArchiveEntryDetails(
  archivePath: string,
): Promise<Array<{ path: string; linkpath?: string; type?: string }>> {
  const entries: Array<{ path: string; linkpath?: string; type?: string }> = [];
  await tar.t({
    file: archivePath,
    gzip: true,
    onentry: (entry) => {
      entries.push({
        path: entry.path,
        ...(entry.linkpath ? { linkpath: entry.linkpath } : {}),
        ...(entry.type ? { type: entry.type } : {}),
      });
      entry.resume();
    },
  });
  return entries;
}

async function extractArchiveToTemp(archivePath: string): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-test-extract-"));
  await tar.x({
    file: archivePath,
    gzip: true,
    cwd: tempDir,
  });
  return tempDir;
}

function countDeliveryQueueRows(sqlitePath: string): number {
  const sqlite = requireNodeSqlite();
  const db = new sqlite.DatabaseSync(sqlitePath, { readOnly: true });
  try {
    const row = db.prepare("SELECT COUNT(*) AS count FROM delivery_queue_entries").get() as
      | { count?: number | bigint }
      | undefined;
    const count = row?.count ?? 0;
    return typeof count === "bigint" ? Number(count) : count;
  } finally {
    db.close();
  }
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("formatBackupCreateSummary", () => {
  const backupArchiveLine = "Backup archive: /tmp/openclaw-backup.tar.gz";

  it.each([
    {
      name: "formats created archives with included and skipped paths",
      result: makeResult({
        verified: true,
        assets: [
          {
            kind: "state",
            sourcePath: "/state",
            archivePath: "archive/state",
            displayPath: "~/.openclaw",
          },
        ],
        skipped: [
          {
            kind: "workspace",
            sourcePath: "/workspace",
            displayPath: "~/Projects/openclaw",
            reason: "covered",
            coveredBy: "~/.openclaw",
          },
        ],
      }),
      expected: [
        backupArchiveLine,
        "Included 1 path:",
        "- state: ~/.openclaw",
        "Skipped 1 path:",
        "- workspace: ~/Projects/openclaw (covered by ~/.openclaw)",
        "Created /tmp/openclaw-backup.tar.gz",
        "Archive verification: passed",
      ],
    },
    {
      name: "formats dry runs and pluralized counts",
      result: makeResult({
        dryRun: true,
        assets: [
          {
            kind: "config",
            sourcePath: "/config",
            archivePath: "archive/config",
            displayPath: "~/.openclaw/config.json",
          },
          {
            kind: "credentials",
            sourcePath: "/oauth",
            archivePath: "archive/oauth",
            displayPath: "~/.openclaw/oauth",
          },
        ],
      }),
      expected: [
        backupArchiveLine,
        "Included 2 paths:",
        "- config: ~/.openclaw/config.json",
        "- credentials: ~/.openclaw/oauth",
        "Dry run only; archive was not written.",
      ],
    },
  ])("$name", ({ result, expected }) => {
    expect(formatBackupCreateSummary(result)).toEqual(expected);
  });

  it("surfaces the volatile skip count in the summary", () => {
    expect(
      formatBackupCreateSummary(
        makeResult({
          assets: [
            {
              kind: "state",
              sourcePath: "/state",
              archivePath: "archive/state",
              displayPath: "~/.openclaw",
            },
          ],
          skippedVolatileCount: 3,
        }),
      ),
    ).toEqual([
      "Backup archive: /tmp/openclaw-backup.tar.gz",
      "Included 1 path:",
      "- state: ~/.openclaw",
      "Created /tmp/openclaw-backup.tar.gz",
      "Skipped 3 volatile files (live sessions, cron logs, queues, sockets, pid/tmp).",
    ]);
  });
});

describe("isTarEofRaceError", () => {
  const { isTarEofRaceError } = backupCreateInternals;

  it.each([
    "did not encounter expected EOF",
    "encountered unexpected EOF",
    "TAR_BAD_ARCHIVE: Unrecognized archive format",
    "Truncated input (needed 512 more bytes, only 0 available) (TAR_BAD_ARCHIVE)",
  ])("matches tar-specific EOF-class error: %s", (message) => {
    expect(isTarEofRaceError(new Error(message))).toBe(true);
  });

  it("matches errors by code even when the message is empty", () => {
    expect(isTarEofRaceError(Object.assign(new Error(""), { code: "EOF" }))).toBe(true);
  });

  it.each([
    "EOF occurred in violation of protocol",
    "unexpected eof while reading",
    "ran out of EOF markers",
    "permission denied",
    "",
  ])("does not match unrelated errors: %s", (message) => {
    expect(isTarEofRaceError(new Error(message))).toBe(false);
  });

  it("rejects non-object inputs", () => {
    expect(isTarEofRaceError(null)).toBe(false);
    expect(isTarEofRaceError(undefined)).toBe(false);
    expect(isTarEofRaceError("did not encounter expected EOF")).toBe(false);
  });
});

describe("writeTarArchiveWithRetry", () => {
  it("retries on EOF-class errors and eventually succeeds", async () => {
    const eofErr = Object.assign(new Error("did not encounter expected EOF"), {
      path: "/state/sessions/s-abc/transcript.jsonl",
    });
    const runTar = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(eofErr)
      .mockRejectedValueOnce(eofErr)
      .mockResolvedValueOnce(undefined);
    const log = vi.fn();
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

    await backupCreateInternals.writeTarArchiveWithRetry({
      tempArchivePath: "/tmp/backup.tar.gz.tmp",
      runTar,
      log,
      sleepMs: sleep,
    });

    expect(runTar).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 10_000);
    expect(sleep).toHaveBeenNthCalledWith(2, 20_000);
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("surfaces the offending path and attempt count after exhausting retries", async () => {
    const eofErr = Object.assign(new Error("did not encounter expected EOF"), {
      path: "/state/logs/gateway.jsonl",
    });
    const runTar = vi.fn<() => Promise<void>>().mockRejectedValue(eofErr);
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

    await expect(
      backupCreateInternals.writeTarArchiveWithRetry({
        tempArchivePath: "/tmp/backup.tar.gz.tmp",
        runTar,
        sleepMs: sleep,
      }),
    ).rejects.toThrow(/last offending path: \/state\/logs\/gateway\.jsonl, after 3 attempts/);
    expect(runTar).toHaveBeenCalledTimes(3);
  });

  it("lets callers reset per-attempt counters so retries report the final attempt's count, not a running sum", async () => {
    // Simulate the caller's pattern: a closure counter populated by a filter
    // that tar.c invokes while walking the tree. Each attempt re-walks the
    // same tree, so the runTar closure must reset the counter before calling
    // tar.c -- otherwise the reported count accumulates across attempts.
    let skippedVolatileCount = 0;
    const volatileFilesSeenPerAttempt = 5;
    let attempt = 0;

    const eofErr = Object.assign(new Error("did not encounter expected EOF"), {
      path: "/state/sessions/s-abc/transcript.jsonl",
    });

    const runTar = vi.fn<() => Promise<void>>().mockImplementation(async () => {
      attempt += 1;
      skippedVolatileCount = 0;
      for (let i = 0; i < volatileFilesSeenPerAttempt; i += 1) {
        skippedVolatileCount += 1;
      }
      if (attempt < 3) {
        throw eofErr;
      }
    });
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

    await backupCreateInternals.writeTarArchiveWithRetry({
      tempArchivePath: "/tmp/backup.tar.gz.tmp",
      runTar,
      sleepMs: sleep,
    });

    expect(runTar).toHaveBeenCalledTimes(3);
    // Without the reset, this would be 15 (5 * 3 attempts). With the reset,
    // it equals the count from the final (successful) attempt.
    expect(skippedVolatileCount).toBe(volatileFilesSeenPerAttempt);
  });

  it("does not retry on non-EOF errors", async () => {
    const runTar = vi.fn<() => Promise<void>>().mockRejectedValue(new Error("permission denied"));
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

    await expect(
      backupCreateInternals.writeTarArchiveWithRetry({
        tempArchivePath: "/tmp/backup.tar.gz.tmp",
        runTar,
        sleepMs: sleep,
      }),
    ).rejects.toThrow(/permission denied/);
    expect(runTar).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("buildExtensionsNodeModulesFilter", () => {
  it("excludes dependency trees only under state extensions", () => {
    const filter = buildExtensionsNodeModulesFilter("/state/");

    expect(filter("/state/extensions/demo/openclaw.plugin.json")).toBe(true);
    expect(filter("/state/extensions/demo/src/index.js")).toBe(true);
    expect(filter("/state/extensions/demo/node_modules/dep/index.js")).toBe(false);
    expect(filter("/state/extensions/demo/vendor/node_modules/dep/index.js")).toBe(false);
    expect(filter("/state/node_modules/dep/index.js")).toBe(true);
    expect(filter("/state/extensions-node_modules/demo/index.js")).toBe(true);
  });

  it("normalizes Windows path separators", () => {
    const filter = buildExtensionsNodeModulesFilter("C:\\Users\\me\\.openclaw\\");

    expect(filter(String.raw`C:\Users\me\.openclaw\extensions\demo\index.js`)).toBe(true);
    expect(
      filter(String.raw`C:\Users\me\.openclaw\extensions\demo\node_modules\dep\index.js`),
    ).toBe(false);
  });
});

describe("createBackupArchive", () => {
  it("skips current live volatile state files while preserving workspace locks", async () => {
    await withOpenClawTestState(
      {
        layout: "split",
        prefix: "openclaw-backup-volatile-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        await state.writeConfig({
          agents: {
            list: [{ id: "main", default: true, workspace: state.workspaceDir }],
          },
        });
        await fs.mkdir(outputDir, { recursive: true });
        await fs.writeFile(path.join(state.workspaceDir, "Cargo.lock"), "workspace lock\n", "utf8");
        await fs.writeFile(
          path.join(state.workspaceDir, "pending.tmp"),
          "workspace temp fixture\n",
          "utf8",
        );
        await state.writeText("agents/main/sessions/live-session.jsonl", "session\n");
        await state.writeText("sessions/legacy-session.jsonl", "legacy session\n");
        await state.writeText("cron/runs/nightly.jsonl", "cron\n");
        await state.writeText("logs/gateway.log", "log\n");
        await state.writeJson("delivery-queue/message.json", { id: "delivery" });
        await state.writeJson("session-delivery-queue/message.json", { id: "session-delivery" });
        await state.writeText("tmp/staged.tmp", "tmp\n");
        await state.writeText("gateway.pid", "123\n");

        const result = await createBackupArchive({
          output: outputDir,
          includeWorkspace: true,
          nowMs: Date.UTC(2026, 4, 9, 8, 0, 0),
        });
        const entries = await listArchiveEntries(result.archivePath);

        expect(entries.some((entry) => entry.endsWith("/workspace/Cargo.lock"))).toBe(true);
        expect(entries.some((entry) => entry.endsWith("/workspace/pending.tmp"))).toBe(true);
        for (const suffix of [
          "/state/agents/main/sessions/live-session.jsonl",
          "/state/sessions/legacy-session.jsonl",
          "/state/cron/runs/nightly.jsonl",
          "/state/logs/gateway.log",
          "/state/delivery-queue/message.json",
          "/state/session-delivery-queue/message.json",
          "/state/tmp/staged.tmp",
          "/state/gateway.pid",
        ]) {
          expect(
            entries.some((entry) => entry.endsWith(suffix)),
            suffix,
          ).toBe(false);
        }
        expect(result.skippedVolatileCount).toBe(8);
      },
    );
  });

  it("omits installed plugin node_modules from the real archive while keeping plugin files", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-plugin-deps-",
        scenario: "minimal",
      },
      async (state) => {
        const stateDir = state.stateDir;
        const outputDir = state.path("backups");
        await fs.mkdir(path.join(stateDir, "extensions", "demo", "node_modules", "dep"), {
          recursive: true,
        });
        await fs.mkdir(path.join(stateDir, "extensions", "demo", "src"), { recursive: true });
        await fs.mkdir(path.join(stateDir, "node_modules", "root-dep"), { recursive: true });
        await fs.writeFile(
          path.join(stateDir, "extensions", "demo", "openclaw.plugin.json"),
          '{"id":"demo"}\n',
          "utf8",
        );
        await fs.writeFile(
          path.join(stateDir, "extensions", "demo", "src", "index.js"),
          "export default {}\n",
          "utf8",
        );
        await fs.writeFile(
          path.join(stateDir, "extensions", "demo", "node_modules", "dep", "index.js"),
          "module.exports = {}\n",
          "utf8",
        );
        await fs.writeFile(
          path.join(stateDir, "node_modules", "root-dep", "index.js"),
          "module.exports = {}\n",
          "utf8",
        );
        await fs.mkdir(outputDir, { recursive: true });
        const database = openOpenClawStateDatabase();
        const db = getNodeSqliteKysely<BackupCreateTestDatabase>(database.db);
        executeSqliteQuerySync(
          database.db,
          db.insertInto("diagnostic_events").values({
            scope: "backup-test",
            event_key: "seed",
            payload_json: "{}",
            created_at: 1,
          }),
        );

        const result = await createBackupArchive({
          output: outputDir,
          includeWorkspace: false,
          nowMs: Date.UTC(2026, 3, 28, 12, 0, 0),
        });
        const entries = await listArchiveEntries(result.archivePath);

        const entrySuffixes = entries.map((entry) => entry.replace(/^.*\/state\//, "/state/"));
        expect(entrySuffixes).toContain("/state/extensions/demo/openclaw.plugin.json");
        expect(entrySuffixes).toContain("/state/extensions/demo/src/index.js");
        expect(entrySuffixes).toContain("/state/node_modules/root-dep/index.js");
        const pluginNodeModuleEntries = entries.filter((entry) =>
          entry.includes("/state/extensions/demo/node_modules/"),
        );
        expect(pluginNodeModuleEntries).toStrictEqual([]);
        expect(entries.some((entry) => entry.endsWith("/state/state/openclaw.sqlite"))).toBe(true);

        const backupRuns = executeSqliteQuerySync(
          database.db,
          db.selectFrom("backup_runs").selectAll(),
        ).rows;
        expect(backupRuns).toHaveLength(1);
        expect(backupRuns[0]?.archive_path).toBe(result.archivePath);
        expect(backupRuns[0]?.status).toBe("completed");
        const manifest = JSON.parse(backupRuns[0]?.manifest_json ?? "{}") as {
          databaseSnapshots?: Array<{
            role?: string;
            archivePath?: string;
            integrity?: string;
          }>;
        };
        expect(manifest.databaseSnapshots).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              role: "global",
              integrity: "ok",
              archivePath: expect.stringContaining("/state/state/openclaw.sqlite"),
            }),
          ]),
        );

        const runtime: RuntimeEnv = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
        const verification = await backupVerifyCommand(runtime, { archive: result.archivePath });
        expect(verification.ok).toBe(true);
      },
    );
  });

  it("scrubs volatile delivery queue rows from SQLite snapshots", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-queue-scrub-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        await fs.mkdir(outputDir, { recursive: true });
        const database = openOpenClawStateDatabase();
        const db = getNodeSqliteKysely<BackupCreateTestDatabase>(database.db);
        executeSqliteQuerySync(
          database.db,
          db.insertInto("delivery_queue_entries").values({
            queue_name: "outbound",
            id: "queued-send",
            status: "pending",
            entry_kind: "message",
            session_key: "session-1",
            channel: "telegram",
            target: "chat-1",
            account_id: null,
            entry_json: JSON.stringify({ text: "do not replay" }),
            enqueued_at: 1,
            updated_at: 1,
          }),
        );

        const result = await createBackupArchive({
          output: outputDir,
          includeWorkspace: false,
          nowMs: Date.UTC(2026, 4, 11, 12, 0, 0),
        });
        const stateAsset = result.assets.find((asset) => asset.kind === "state");
        expect(stateAsset).toBeDefined();
        const extractDir = await extractArchiveToTemp(result.archivePath);
        try {
          const archivedStateDb = path.join(
            extractDir,
            stateAsset!.archivePath,
            "state",
            "openclaw.sqlite",
          );
          expect(countDeliveryQueueRows(archivedStateDb)).toBe(0);
        } finally {
          await fs.rm(extractDir, { recursive: true, force: true });
        }
      },
    );
  });

  it("dereferences hardlinks instead of emitting restore-hostile Link entries", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-hardlink-",
        scenario: "minimal",
      },
      async (state) => {
        const stateDir = state.stateDir;
        const outputDir = state.path("backups");
        const sourcePath = path.join(stateDir, "workspace-adx", "openclaw-src", "node_modules");
        const targetPath = path.join(sourcePath, "esbuild", "bin", "esbuild");
        const hardlinkPath = path.join(sourcePath, "@esbuild", "darwin-arm64", "bin", "esbuild");
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.mkdir(path.dirname(hardlinkPath), { recursive: true });
        await fs.writeFile(targetPath, "binary fixture\n", "utf8");
        await fs.link(targetPath, hardlinkPath);
        await fs.mkdir(outputDir, { recursive: true });

        const result = await createBackupArchive({
          output: outputDir,
          includeWorkspace: false,
          nowMs: Date.UTC(2026, 3, 29, 12, 0, 0),
        });
        const entries = await listArchiveEntryDetails(result.archivePath);

        expect(entries.filter((entry) => entry.type === "Link")).toStrictEqual([]);
        expect(entries.some((entry) => entry.path.endsWith("/esbuild/bin/esbuild"))).toBe(true);
        expect(
          entries.some((entry) => entry.path.endsWith("/@esbuild/darwin-arm64/bin/esbuild")),
        ).toBe(true);

        const runtime: RuntimeEnv = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
        const verification = await backupVerifyCommand(runtime, { archive: result.archivePath });
        expect(verification.ok).toBe(true);
      },
    );
  });

  it("does not duplicate the root manifest when the system tempdir lives inside the state dir", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-tmp-overlap-",
        scenario: "minimal",
      },
      async (state) => {
        const stateDir = state.stateDir;
        const outputDir = state.path("backups");
        const overlappingTmp = path.join(stateDir, "tmp");
        await fs.mkdir(overlappingTmp, { recursive: true });
        await fs.mkdir(outputDir, { recursive: true });
        const tmpdirSpy = vi.spyOn(os, "tmpdir").mockReturnValue(overlappingTmp);

        try {
          const result = await createBackupArchive({
            output: outputDir,
            includeWorkspace: false,
            nowMs: Date.UTC(2026, 4, 9, 12, 0, 0),
          });
          const entries = await listArchiveEntries(result.archivePath);
          const rootManifestEntries = entries.filter(
            (entry) => entry.endsWith("/manifest.json") && !entry.includes("/payload/"),
          );
          expect(rootManifestEntries).toHaveLength(1);

          const runtime: RuntimeEnv = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
          const verification = await backupVerifyCommand(runtime, { archive: result.archivePath });
          expect(verification.ok).toBe(true);
        } finally {
          tmpdirSpy.mockRestore();
        }
      },
    );
  });

  it("does not duplicate the root manifest when the system tempdir is the state dir itself", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-tmp-equals-state-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        await fs.mkdir(outputDir, { recursive: true });
        const tmpdirSpy = vi.spyOn(os, "tmpdir").mockReturnValue(state.stateDir);

        try {
          const result = await createBackupArchive({
            output: outputDir,
            includeWorkspace: false,
            nowMs: Date.UTC(2026, 4, 9, 12, 0, 0),
          });
          const entries = await listArchiveEntries(result.archivePath);
          const rootManifestEntries = entries.filter(
            (entry) => entry.endsWith("/manifest.json") && !entry.includes("/payload/"),
          );
          expect(rootManifestEntries).toHaveLength(1);

          const runtime: RuntimeEnv = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
          const verification = await backupVerifyCommand(runtime, { archive: result.archivePath });
          expect(verification.ok).toBe(true);
        } finally {
          tmpdirSpy.mockRestore();
        }
      },
    );
  });
});
