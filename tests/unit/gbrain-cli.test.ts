import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { CliError, runGbrain, runGbrainJson } from "../../packages/core/src/gbrain-cli";
import type { Config } from "../../packages/core/src/config";

const tmp = mkdtempSync(path.join(os.tmpdir(), "gbrain-cli-test-"));
// 假 gbrain 二进制：回显 argv/env，支持受控行为
const fakeBin = path.join(tmp, "fake-gbrain");
writeFileSync(
  fakeBin,
  `#!/usr/bin/env bash
if [[ "$1" == "--fail" ]]; then echo "boom" >&2; exit 3; fi
if [[ "$1" == "--jsonout" ]]; then echo '{"ok": true}'; exit 0; fi
echo "ARGV: $*"
echo "SRC: \${GBRAIN_SOURCE-unset}"
`,
);
chmodSync(fakeBin, 0o755);

const cfg = { GBRAIN_BIN: fakeBin } as Config;

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("runGbrain", () => {
  test("argv 透传与 GBRAIN_SOURCE 钉定", async () => {
    const r = await runGbrain(cfg, { args: ["sources", "list"], source: "kb-ab12cd34" });
    expect(r.stdout).toContain("ARGV: sources list");
    expect(r.stdout).toContain("SRC: kb-ab12cd34");
  });

  test("未指定 source 时不注入", async () => {
    const r = await runGbrain(cfg, { args: ["stats"] });
    expect(r.stdout).toContain("SRC: unset");
  });

  test("非零退出抛 CliError 且带 stderr", async () => {
    expect(runGbrain(cfg, { args: ["--fail"] })).rejects.toBeInstanceOf(CliError);
    try {
      await runGbrain(cfg, { args: ["--fail"] });
    } catch (e) {
      expect((e as CliError).exitCode).toBe(3);
      expect((e as CliError).stderr).toContain("boom");
    }
  });

  test("runGbrainJson 追加 --json 并解析", async () => {
    const j = await runGbrainJson<{ ok: boolean }>(cfg, { args: ["--jsonout"] });
    expect(j.ok).toBe(true);
  });
});
