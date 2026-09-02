import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { InternalRetrieval } from "../../packages/core/src/retrieval-serve";
import { retrieveWithFallback } from "../../packages/core/src/retrieval";
import type { Upstream } from "../../packages/core/src/gbrain-upstream";
import type { Config } from "../../packages/core/src/config";

/**
 * T049 fallback 测试（CHK020/CHK021）：
 * - serve 通道成功/非JSON/故障三种形态
 * - retrieveWithFallback 故障时降级 CLI spawn 且响应形状一致
 */

const tmp = mkdtempSync(path.join(os.tmpdir(), "retr-test-"));
const fakeBin = path.join(tmp, "fake-gbrain");
writeFileSync(
  fakeBin,
  `#!/usr/bin/env bash
case "$1 $2" in
  "auth register-client") echo "Client ID: gbrain_cl_testid"; echo "Client Secret: gbrain_cs_testsecret";;
  "sources list") echo '{"sources":[{"id":"kb-12345678"}]}';; 
  "sources archived") echo '{"archived":[]}';; 
  "auth clients") echo '{"clients":[]}';;
  "search "*) echo '[{"slug":"cli-slug","title":"t","chunk_text":"cli content","score":1,"source_id":"kb-12345678"}]';;
  "query "*) echo '[{"slug":"cli-slug","title":"t","chunk_text":"cli content","score":1,"source_id":"kb-12345678"}]';;
  *) exit 0;;
esac
`,
);
chmodSync(fakeBin, 0o755);

const cfg = { GBRAIN_BIN: fakeBin, GBRAIN_SERVE_PORT: 7333, JOB_TIMEOUT_MS: 600_000 } as Config;

function mkUpstream(body: string, status = 200): Upstream {
  return {
    proxy: async () => new Response(body, { status, headers: { "Content-Type": "application/json" } }),
    token: async () => "test-token",
    invalidate: () => undefined,
  } as unknown as Upstream;
}

const INPUT = { query: "anything", mode: "keyword" as const, topK: 5 };

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("InternalRetrieval.retrieve（serve 通道）", () => {
  test("JSON-RPC 文本解析为命中", async () => {
    const serve = new InternalRetrieval(cfg, mkUpstream(
      JSON.stringify({ result: { content: [{ type: "text", text: JSON.stringify([{ slug: "serve-slug", title: "t", chunk_text: "serve content", score: 0.9, source_id: "kb-12345678" }]) }] } }),
    ));
    const r = await serve.retrieve("kb-12345678", INPUT);
    expect(r.results.length).toBe(1);
    expect(r.results[0]!.slug).toBe("serve-slug");
    expect(r.results[0]!.sourceId).toBe("kb-12345678");
    expect(r.mode).toBe("keyword");
  });

  test("非 JSON 内容抛错（触发降级）", async () => {
    const serve = new InternalRetrieval(cfg, mkUpstream(
      JSON.stringify({ result: { content: [{ type: "text", text: "not a json array" }] } }),
    ));
    expect(serve.retrieve("kb-12345678", INPUT)).rejects.toThrow();
  });

  test("上游 500 抛错", async () => {
    const serve = new InternalRetrieval(cfg, mkUpstream("boom", 500));
    expect(serve.retrieve("kb-12345678", INPUT)).rejects.toThrow();
  });
});

describe("retrieveWithFallback（降级封装）", () => {
  test("serve 成功 → 用 serve 结果", async () => {
    const result = await retrieveWithFallback(
      cfg,
      async () => ({ results: [], mode: "keyword", degraded: [] }),
      "kb-12345678",
      INPUT,
    );
    expect(result.mode).toBe("keyword");
  });

  test("serve 故障 → 降级 CLI spawn，形状一致", async () => {
    const result = await retrieveWithFallback(
      cfg,
      async () => {
        throw new Error("serve down");
      },
      "kb-12345678",
      INPUT,
    );
    expect(result.results.length).toBe(1);
    expect(result.results[0]!.slug).toBe("cli-slug");
    expect(result.results[0]!.snippet).toBe("cli content");
  });

  test("serve 非 JSON → 降级 CLI（InternalRetrieval + 封装串联）", async () => {
    const serve = new InternalRetrieval(cfg, mkUpstream(
      JSON.stringify({ result: { content: [{ type: "text", text: "garbage" }] } }),
    ));
    const result = await retrieveWithFallback(cfg, (k, i) => serve.retrieve(k, i), "kb-12345678", INPUT);
    expect(result.results[0]!.slug).toBe("cli-slug");
  });
});
