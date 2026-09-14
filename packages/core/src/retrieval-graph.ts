/**
 * 图谱增强检索（008 扩展）：向量找入口 → 图谱展开相邻文档。
 *
 * 分工（实测对照见 docs/usage.md）：
 * - 向量回答「哪些文档和我的问题**说法相近**」
 * - 图谱回答「哪些文档在用我关心的**这个概念**」
 *
 * 本模块只做纯计算（可单测）；引擎调用在 retrieval-serve 的编排里。
 * 图谱命中的文档**不给分**——它们不是排序结果而是**推导出的关联**，故独立的
 * `graph_results` 数组 + 溯源（经哪些概念、由哪篇种子文档连到），不混入向量排名，
 * 避免凭空造分数。
 */
import { isDocSlug } from "./entity-graph";

/** 引擎 traverse_graph 返回的关系边（字段为 snake_case） */
export interface GraphPath {
  from_slug?: unknown;
  to_slug?: unknown;
  link_type?: unknown;
  depth?: unknown;
}

export interface GraphExpansionOptions {
  /** 每篇种子文档的展开跳数（2 = 文档→概念→相邻文档） */
  depth: number;
  /** 用向量前 N 条做种子（缺省 = 全部返回结果） */
  seedK?: number;
  /** 图谱发现结果上限 */
  maxResults: number;
}

export interface GraphHit {
  /** 发现的文档（全路径 slug） */
  slug: string;
  /** 连接该文档与种子文档的概念（entities/ 尾段名） */
  via_concepts: string[];
  /** 参与发现它的种子文档 slug */
  seed_slugs: string[];
  /** 共现概念数（原始计数） */
  shared_concepts: number;
  /**
   * 特异性加权分：`Σ 1/fanout(概念)`，`fanout` = 该概念在本轮连到的相邻文档数。
   * 品牌名之类**无处不在**的概念 fanout 大 → 贡献趋近 0；真正把这篇文档与种子
   * 绑在一起的概念 fanout 小 → 贡献接近 1。排序依据（而非原始计数，后者会被
   * 高频概念主导）。
   */
  weight: number;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const isEntity = (kbId: string, slug: string): boolean => slug.startsWith(`${kbId}/entities/`);
const conceptName = (slug: string): string => slug.slice(slug.lastIndexOf("/") + 1);

/**
 * 从"每篇种子文档的关系边"里收集相邻文档。
 *
 * 依赖引擎的遍历形态（`direction=both`, `depth=2`）：边在库中恒为 `文档 → 概念`，
 * 故
 * - 深度 1 的边：`种子 → 概念`（这些概念即"种子涉及的概念"）
 * - 深度 2 的边：`相邻文档 → 概念`
 * 据此把 `深度2 的文档端` 认作发现结果，`概念端` 认作溯源概念。
 * （两种朝向都接受，避免依赖单侧方向假设。）
 */
export function collectGraphDocs(
  kbId: string,
  seeds: readonly string[],
  pathsBySeed: ReadonlyMap<string, readonly GraphPath[]>,
  opts: GraphExpansionOptions,
  exclude: ReadonlySet<string> = new Set(),
): GraphHit[] {
  const seedSet = new Set(seeds);
  // slug → { concepts:Set, seeds:Set }
  const found = new Map<string, { concepts: Set<string>; seeds: Set<string> }>();

  for (const [seed, paths] of pathsBySeed) {
    // ① 种子涉及的概念（深度 1：任一端是种子，另一端是概念）
    const seedConcepts = new Set<string>();
    for (const p of paths) {
      const from = str(p.from_slug);
      const to = str(p.to_slug);
      if (from === seed && isEntity(kbId, to)) seedConcepts.add(to);
      else if (to === seed && isEntity(kbId, from)) seedConcepts.add(from);
    }
    // ② 相邻文档（深度 ≥2：一端是文档、另一端是种子概念）
    for (const p of paths) {
      const depth = typeof p.depth === "number" ? p.depth : 0;
      if (depth < 2) continue;
      const from = str(p.from_slug);
      const to = str(p.to_slug);
      const pairs: Array<[string, string]> = [
        [from, to],
        [to, from],
      ];
      for (const [docSide, entitySide] of pairs) {
        if (!isDocSlug(kbId, docSide) || !isEntity(kbId, entitySide)) continue;
        if (docSide === seed || seedSet.has(docSide) || exclude.has(docSide)) continue;
        if (!seedConcepts.has(entitySide)) continue;
        let entry = found.get(docSide);
        if (!entry) {
          entry = { concepts: new Set(), seeds: new Set() };
          found.set(docSide, entry);
        }
        entry.concepts.add(entitySide);
        entry.seeds.add(seed);
      }
    }
  }

  return finishHits(found, opts.maxResults);
}

/**
 * 收尾：算概念 fanout（该概念在本轮连到多少篇相邻文档）→ 特异性加权 → 排序截断。
 * 拆成独立函数便于单测。
 */
function finishHits(
  found: ReadonlyMap<string, { concepts: Set<string>; seeds: Set<string> }>,
  maxResults: number,
): GraphHit[] {
  if (found.size === 0) return [];

  // 概念 → 连到的相邻文档数（泛化度：越大越不具区分力）
  const fanout = new Map<string, number>();
  for (const { concepts } of found.values()) {
    for (const c of concepts) fanout.set(c, (fanout.get(c) ?? 0) + 1);
  }

  return [...found]
    .map(([slug, e]) => {
      const weight = [...e.concepts].reduce((sum, c) => sum + 1 / (fanout.get(c) ?? 1), 0);
      return {
        slug,
        via_concepts: [...e.concepts].map(conceptName).sort(),
        seed_slugs: [...e.seeds].sort(),
        shared_concepts: e.concepts.size,
        weight: Math.round(weight * 1000) / 1000,
      };
    })
    .sort((a, b) => b.weight - a.weight || a.slug.localeCompare(b.slug))
    .slice(0, maxResults);
}
