import { describe, expect, test } from "bun:test";
import { collectGraphDocs, type GraphPath } from "../../packages/core/src/retrieval-graph";

const KB = "kb-1234abcd";
const seed = `${KB}/docs/seed`;
const other = `${KB}/docs/other`;
const third = `${KB}/docs/third`;
const eBrake = `${KB}/entities/brake`;
const eFluid = `${KB}/entities/brake-fluid`;
const eTire = `${KB}/entities/tire`;

/** 引擎遍历形态：深度1 = 种子→概念；深度2 = 相邻文档→概念 */
function paths(...rows: GraphPath[]): GraphPath[] {
  return rows;
}
const edge = (from: string, to: string, depth: number): GraphPath => ({ from_slug: from, to_slug: to, depth, link_type: "wikilink_basename" });

describe("collectGraphDocs 图谱增强检索（纯逻辑）", () => {
  test("收集相邻文档并溯源到连接概念与种子", () => {
    const bySeed = new Map([
      [
        seed,
        paths(
          edge(seed, eBrake, 1),
          edge(seed, eFluid, 1),
          edge(other, eBrake, 2),
          edge(other, eFluid, 2),
        ),
      ],
    ]);
    const hits = collectGraphDocs(KB, [seed], bySeed, { depth: 2, maxResults: 10 });
    expect(hits).toEqual([
      {
        slug: other,
        via_concepts: ["brake", "brake-fluid"],
        seed_slugs: [seed],
        shared_concepts: 2,
        weight: 2, // 两概念各只连到 1 篇相邻文档 → 各贡献 1
      },
    ]);
  });

  test("按共现概念数降序（更强的关联排前）", () => {
    const bySeed = new Map([
      [
        seed,
        paths(
          edge(seed, eBrake, 1),
          edge(seed, eFluid, 1),
          edge(other, eBrake, 2),
          edge(other, eFluid, 2),
          edge(third, eTire, 2),
        ),
      ],
    ]);
    const hits = collectGraphDocs(KB, [seed], bySeed, { depth: 2, maxResults: 10 });
    // third 与种子无共同概念（tire 不在种子概念里）→ 不应被收集
    expect(hits.map((h) => h.slug)).toEqual([other]);
  });

  test("与种子无共同概念的同层文档被剔除", () => {
    const bySeed = new Map([
      [seed, paths(edge(seed, eBrake, 1), edge(third, eTire, 2))],
    ]);
    expect(collectGraphDocs(KB, [seed], bySeed, { depth: 2, maxResults: 10 })).toEqual([]);
  });

  test("种子自身与已在向量结果中的文档不重复出现", () => {
    const bySeed = new Map([
      [seed, paths(edge(seed, eBrake, 1), edge(other, eBrake, 2), edge(third, eBrake, 2))],
    ]);
    const hits = collectGraphDocs(KB, [seed], bySeed, { depth: 2, maxResults: 10 }, new Set([other]));
    expect(hits.map((h) => h.slug)).toEqual([third]);
  });

  test("多篇种子各自独立溯源，同一文档可被多篇种子发现", () => {
    const bySeed = new Map([
      [seed, paths(edge(seed, eBrake, 1), edge(other, eBrake, 2))],
      [third, paths(edge(third, eBrake, 1), edge(other, eBrake, 2))],
    ]);
    const hits = collectGraphDocs(KB, [seed, third], bySeed, { depth: 2, maxResults: 10 });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.seed_slugs).toEqual([seed, third].sort());
  });

  test("max_results 截断", () => {
    const bySeed = new Map([
      [seed, paths(edge(seed, eBrake, 1), edge(other, eBrake, 2), edge(third, eBrake, 2))],
    ]);
    expect(collectGraphDocs(KB, [seed], bySeed, { depth: 2, maxResults: 1 })).toHaveLength(1);
  });

  test("跨库文档与概念一律不收（租户隔离）", () => {
    const bySeed = new Map([
      [
        seed,
        paths(
          edge(seed, eBrake, 1),
          edge("kb-99999999/docs/foreign", eBrake, 2),
          edge(other, "kb-99999999/entities/x", 2),
        ),
      ],
    ]);
    expect(collectGraphDocs(KB, [seed], bySeed, { depth: 2, maxResults: 10 })).toEqual([]);
  });

  test("深度 1 的边不入结果（只有概念，没有相邻文档）", () => {
    const bySeed = new Map([[seed, paths(edge(seed, eBrake, 1))]]);
    expect(collectGraphDocs(KB, [seed], bySeed, { depth: 2, maxResults: 10 })).toEqual([]);
  });

  test("方向反转（概念→文档）同样识别", () => {
    const bySeed = new Map([[seed, paths(edge(seed, eBrake, 1), edge(eBrake, other, 2))]]);
    const hits = collectGraphDocs(KB, [seed], bySeed, { depth: 2, maxResults: 10 });
    expect(hits.map((h) => h.slug)).toEqual([other]);
  });

  test("空输入与畸形路径安全", () => {
    expect(collectGraphDocs(KB, [], new Map(), { depth: 2, maxResults: 10 })).toEqual([]);
    const bySeed = new Map([[seed, paths({}, { from_slug: 123 }, { from_slug: seed, to_slug: null, depth: 2 })]]);
    expect(collectGraphDocs(KB, [seed], bySeed, { depth: 2, maxResults: 10 })).toEqual([]);
  });
});

describe("特异性加权（防高频概念主导排序）", () => {
  test("无处不在的概念贡献趋近 0，专有概念贡献接近 1", () => {
    // seed 涉及 brake(专有) 与 brand(泛化)
    // 3 篇相邻文档都提到 brand，只有 1 篇提到 brake
    const a = `${KB}/docs/a`;
    const b = `${KB}/docs/b`;
    const c = `${KB}/docs/c`;
    const eBrand = `${KB}/entities/brand`;
    const bySeed = new Map([
      [
        seed,
        paths(
          edge(seed, eBrake, 1),
          edge(seed, eBrand, 1),
          edge(a, eBrake, 2),
          edge(a, eBrand, 2),
          edge(b, eBrand, 2),
          edge(c, eBrand, 2),
        ),
      ],
    ]);
    const hits = collectGraphDocs(KB, [seed], bySeed, { depth: 2, maxResults: 10 });
    const bySlug = new Map(hits.map((h) => [h.slug.split("/").pop()!, h]));
    // a：brake fanout=1 → 1；brand fanout=3 → 1/3  ⇒ 1.333
    expect(bySlug.get("a")!.weight).toBe(1.333);
    // b/c：仅 brand ⇒ 0.333，排在 a 之后
    expect(bySlug.get("b")!.weight).toBe(0.333);
    expect(hits.map((h) => h.slug.split("/").pop())).toEqual(["a", "b", "c"]);
    // 原始计数仍是事实（a 有 2 个概念，b/c 只 1 个）
    expect(bySlug.get("a")!.shared_concepts).toBe(2);
    expect(bySlug.get("b")!.shared_concepts).toBe(1);
  });

  test("权重相同时按 slug 稳定排序", () => {
    const x = `${KB}/docs/x`;
    const y = `${KB}/docs/y`;
    const bySeed = new Map([
      [seed, paths(edge(seed, eBrake, 1), edge(y, eBrake, 2), edge(x, eBrake, 2))],
    ]);
    const hits = collectGraphDocs(KB, [seed], bySeed, { depth: 2, maxResults: 10 });
    expect(hits.map((h) => h.slug)).toEqual([x, y]);
  });
});
