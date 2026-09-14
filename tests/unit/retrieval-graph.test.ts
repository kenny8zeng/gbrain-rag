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
