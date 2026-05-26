import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  prepareInternalSessionEffectsTranscript,
  prepareInternalSessionEffectsTranscriptScope,
  removeInternalSessionEffectsTranscript,
} from "./internal-session-effects.js";

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;

afterEach(() => {
  if (ORIGINAL_STATE_DIR === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
  }
});

describe("prepareInternalSessionEffectsTranscript", () => {
  it("creates a private transcript even without a visible source file", async () => {
    await withTempDir({ prefix: "openclaw-internal-session-effects-" }, async (dir) => {
      process.env.OPENCLAW_STATE_DIR = dir;

      const sessionFile = await prepareInternalSessionEffectsTranscript({
        runId: "run/with space",
      });

      expect(sessionFile).toBe(path.join(dir, "internal-agent-runs", "run_with_space.jsonl"));
      expect(await fs.readFile(sessionFile, "utf8")).toBe("");
      expect((await fs.stat(sessionFile)).mode & 0o777).toBe(0o600);

      await removeInternalSessionEffectsTranscript(sessionFile);

      await expect(fs.stat(sessionFile)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("copies a visible source transcript into a private transcript", async () => {
    await withTempDir({ prefix: "openclaw-internal-session-effects-" }, async (dir) => {
      process.env.OPENCLAW_STATE_DIR = dir;
      const sourceFile = path.join(dir, "visible-session.jsonl");
      await fs.writeFile(sourceFile, '{"role":"assistant","content":"done"}\n', {
        mode: 0o644,
      });

      const sessionFile = await prepareInternalSessionEffectsTranscript({
        sessionFile: sourceFile,
        runId: "run-copy",
      });

      expect(await fs.readFile(sessionFile, "utf8")).toBe(
        '{"role":"assistant","content":"done"}\n',
      );
      expect((await fs.stat(sessionFile)).mode & 0o777).toBe(0o600);
    });
  });

  it("creates an empty private transcript when the visible source is missing", async () => {
    await withTempDir({ prefix: "openclaw-internal-session-effects-" }, async (dir) => {
      process.env.OPENCLAW_STATE_DIR = dir;

      const sessionFile = await prepareInternalSessionEffectsTranscript({
        sessionFile: path.join(dir, "missing-session.jsonl"),
        runId: "run-missing-source",
      });

      expect(await fs.readFile(sessionFile, "utf8")).toBe("");
      expect((await fs.stat(sessionFile)).mode & 0o777).toBe(0o600);
    });
  });

  it("resolves a hidden SQLite transcript scope for an internal run", async () => {
    await withTempDir({ prefix: "openclaw-internal-session-effects-" }, async (dir) => {
      process.env.OPENCLAW_STATE_DIR = dir;

      const scope = await prepareInternalSessionEffectsTranscriptScope({
        agentId: "Ops",
        runId: "run/with space",
      });

      expect(scope).toEqual({
        agentId: "ops",
        sessionId: "internal-agent-run:run_with_space",
        sessionKey: "internal-agent-run:run_with_space",
        transcriptFile: path.join(dir, "internal-agent-runs", "run_with_space.jsonl"),
      });
    });
  });
});
