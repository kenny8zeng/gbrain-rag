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
  "search "*) echo '[{"slug":"kb-12345678/docs/cli-slug","title":"t","chunk_text":"cli content","score":1,"source_id":"kb-12345678"}]';;
  "query "*) echo '[{"slug":"kb-12345678/docs/cli-slug","title":"t","chunk_text":"cli content","score":1,"source_id":"kb-12345678"}]';;
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

describe("normalizeHits slug 去重（P4：hybrid 双臂重复）", () => {
  test("同 slug 多次 → 去重保留最高分", async () => {
    const { normalizeHits } = await import("../../packages/core/src/retrieval");
    const hits = normalizeHits([
      { slug: "kb-x/docs/a", title: "A", chunk_text: "low", score: 0.3 },
      { slug: "kb-x/docs/a", title: "A", chunk_text: "high", score: 0.9 },
      { slug: "kb-x/docs/b", title: "B", chunk_text: "b", score: 0.5 },
    ]);
    expect(hits.length).toBe(2);
    expect(hits.find((h) => h.slug.endsWith("/a"))?.score).toBe(0.9);
  });
});

describe("InternalRetrieval.retrieve（serve 通道）", () => {
  test("JSON-RPC 文本解析为命中", async () => {
    const serve = new InternalRetrieval(cfg, mkUpstream(
      JSON.stringify({ result: { content: [{ type: "text", text: JSON.stringify([{ slug: "kb-12345678/docs/serve-slug", title: "t", chunk_text: "serve content", score: 0.9, source_id: "kb-12345678" }]) }] } }),
    ));
    const r = await serve.retrieve("kb-12345678", INPUT);
    expect(r.results.length).toBe(1);
    expect(r.results[0]!.slug).toBe("kb-12345678/docs/serve-slug");
    expect(r.results[0]!.source_id).toBe("kb-12345678");
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
    expect(result.results[0]!.slug).toBe("kb-12345678/docs/cli-slug");
    expect(result.results[0]!.snippet).toBe("cli content");
  });

  test("serve 非 JSON → 降级 CLI（InternalRetrieval + 封装串联）", async () => {
    const serve = new InternalRetrieval(cfg, mkUpstream(
      JSON.stringify({ result: { content: [{ type: "text", text: "garbage" }] } }),
    ));
    const result = await retrieveWithFallback(cfg, (k, i) => serve.retrieve(k, i), "kb-12345678", INPUT);
    expect(result.results[0]!.slug).toBe("kb-12345678/docs/cli-slug");
  });
});

describe("文档面过滤（008：结构兜底 + top_k 截断）", () => {
  test("剔除 entities/ 分区命中，保留 docs/", async () => {
    const { filterDocumentHits } = await import("../../packages/core/src/retrieval");
    const hits = [
      { slug: "kb-x/docs/a", title: "A", snippet: "", score: 0.9, source_id: "kb-x" },
      { slug: "kb-x/entities/battery", title: "Battery", snippet: "", score: 0.95, source_id: "kb-x" },
      { slug: "kb-x/docs/b", title: "B", snippet: "", score: 0.5, source_id: "kb-x" },
    ];
    expect(filterDocumentHits("kb-x", hits).map((h) => h.slug)).toEqual(["kb-x/docs/a", "kb-x/docs/b"]);
  });

  test("他库前缀不算文档（跨库隔离）", async () => {
    const { filterDocumentHits } = await import("../../packages/core/src/retrieval");
    const hits = [{ slug: "kb-other/docs/a", title: "A", snippet: "", score: 1, source_id: "kb-other" }];
    expect(filterDocumentHits("kb-x", hits)).toEqual([]);
  });

  test("top_k 截断（P10 回归：超量返回）", async () => {
    const { filterDocumentHits } = await import("../../packages/core/src/retrieval");
    const mk = (n: number) => ({ slug: `kb-x/docs/${n}`, title: `${n}`, snippet: "", score: 1 - n / 100, source_id: "kb-x" });
    const hits = [mk(1), mk(2), mk(3), mk(4), mk(5)];
    expect(filterDocumentHits("kb-x", hits, 2)).toHaveLength(2);
    expect(filterDocumentHits("kb-x", hits)).toHaveLength(5);
  });

  test("过取上限封顶 100、无 topK 时不过取", async () => {
    const { overFetchLimit } = await import("../../packages/core/src/retrieval");
    expect(overFetchLimit(undefined)).toBeNull();
    expect(overFetchLimit(0)).toBeNull();
    expect(overFetchLimit(2)).toBe(8);
    expect(overFetchLimit(50)).toBe(100);
  });
});

describe("契约字段映射（P10 根因：snake_case → 驼峰）", () => {
  test("body.top_k 必须映射到内部 topK，否则过取/截断静默失效", async () => {
    const seen: Array<{ topK?: number }> = [];
    const { retrieveWithFallback } = await import("../../packages/core/src/retrieval");
    // 复现 handler 的映射：见 apps/server/src/openapi/routes/tenant.ts
    const toInput = (b: { query: string; mode?: "hybrid" | "keyword"; top_k?: number }) =>
      ({ query: b.query, mode: b.mode, topK: b.top_k });
    const input = toInput({ query: "q", mode: "keyword", top_k: 2 });
    await retrieveWithFallback(
      cfg,
      async (_kb, i) => {
        seen.push({ topK: i.topK });
        return { results: [], mode: "keyword", degraded: [] };
      },
      "kb-12345678",
      input,
    );
    expect(seen[0]!.topK).toBe(2);
  });

  test("过取量随 topK 生效（serve 通道 args.limit）", async () => {
    const { overFetchLimit } = await import("../../packages/core/src/retrieval");
    expect(overFetchLimit(2)).toBe(8);
    expect(overFetchLimit(undefined)).toBeNull();
  });
});
