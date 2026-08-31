import { describe, expect, test } from "bun:test";
import { convertFileBytes, convertWebUrl } from "../../packages/core/src/ingest/docling";
import type { Config } from "../../packages/core/src/config";

const cfg = { DOCLING_URL: "https://docling.test", JOB_TIMEOUT_MS: 5000 } as Config;

function okFetch(md: string) {
  return (async () =>
    new Response(JSON.stringify({ document: { md_content: md }, status: "success" }), { status: 200 })) as unknown as typeof fetch;
}

describe("convertFileBytes", () => {
  test("返回 md 内容", async () => {
    const r = await convertFileBytes(cfg, new Uint8Array([1, 2]), "a.pdf", okFetch("# hello") as typeof fetch);
    expect(r.md).toBe("# hello");
    expect(r.status).toBe("success");
  });

  test("空 md 抛错", async () => {
    const bad = (async () => new Response(JSON.stringify({ document: { md_content: "" }, status: "failure" }), { status: 200 })) as unknown as typeof fetch;
    expect(convertFileBytes(cfg, new Uint8Array([1]), "a.pdf", bad)).rejects.toThrow(/empty markdown/);
  });

  test("422 抛错带响应体", async () => {
    const bad = (async () => new Response("unsupported", { status: 422 })) as unknown as typeof fetch;
    expect(convertFileBytes(cfg, new Uint8Array([1]), "a.xyz", bad)).rejects.toThrow(/422/);
  });
});

describe("convertWebUrl", () => {
  test("请求体含 http source 与 to_formats", async () => {
    let captured: RequestInit | undefined;
    const spy = (async (_url: string, init?: RequestInit) => {
      captured = init;
      return new Response(JSON.stringify({ document: { md_content: "page" }, status: "success" }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await convertWebUrl(cfg, "https://example.test/page", spy);
    expect(r.md).toBe("page");
    const body = JSON.parse(String(captured?.body));
    expect(body.sources[0]).toEqual({ kind: "http", url: "https://example.test/page" });
    expect(body.options.to_formats).toEqual(["md"]);
  });
});
