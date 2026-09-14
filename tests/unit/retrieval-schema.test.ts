import { describe, expect, test } from "bun:test";
import { RetrievalBody } from "../../apps/server/src/openapi/schemas";

/**
 * 契约映射防线：P10 的根因是 `top_k` 未映射到内部 `topK`，导致截断静默失效。
 * 图谱参数同样跨这条边界（`seed_k` → `seedK`），故在此钉住。
 */
describe("RetrievalBody 契约（008 图谱增强）", () => {
  test("不带 graph → 纯检索（行为与历史一致）", () => {
    const p = RetrievalBody.parse({ query: "x" });
    expect(p.graph).toBeUndefined();
    expect(p.mode).toBe("hybrid");
  });

  test("graph 缺省值：depth=2 / max_results=10 / seed_k 未设", () => {
    const p = RetrievalBody.parse({ query: "x", graph: {} });
    expect(p.graph).toEqual({ depth: 2, max_results: 10 });
    expect(p.graph!.seed_k).toBeUndefined();
  });

  test("graph 显式值透传（含 seed_k）", () => {
    const p = RetrievalBody.parse({ query: "x", graph: { depth: 3, seed_k: 2, max_results: 5 } });
    expect(p.graph).toEqual({ depth: 3, seed_k: 2, max_results: 5 });
  });

  test("越界拒绝：depth 0/4、max_results 0/51、seed_k 21", () => {
    for (const graph of [{ depth: 0 }, { depth: 4 }, { max_results: 0 }, { max_results: 51 }, { seed_k: 21 }]) {
      expect(RetrievalBody.safeParse({ query: "x", graph }).success).toBe(false);
    }
  });

  test("top_k 与 graph 并存（二者独立）", () => {
    const p = RetrievalBody.parse({ query: "x", top_k: 3, graph: { max_results: 5 } });
    expect(p.top_k).toBe(3);
    expect(p.graph!.max_results).toBe(5);
  });
});
