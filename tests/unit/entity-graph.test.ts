import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { loadConfig } from "../../packages/core/src/config";
import {
  DOC_TYPE,
  ENTITY_TYPE,
  EntityGraphService,
  type CliExec,
  entitySlug,
  extractWikilinkTargets,
  hasEntityMarkerIn,
  isDocSlug,
  isEntitySlug,
  missingEntityTargets,
  selectReclaimCandidates,
  slugifyEntityName,
  stripCodeBlocks,
} from "../../packages/core/src/entity-graph";

const cfg = loadConfig({
  ADMIN_TOKEN: "test-token-0123456789",
  DATABASE_URL: "postgres://stub@127.0.0.1:5/stub",
  DOCLING_URL: "",
} as Record<string, string>);

const KB = "kb-1234abcd";

describe("slugifyEntityName 镜像引擎 slugifySegment", () => {
  test("CJK 原样保留", () => {
    expect(slugifyEntityName("电池")).toBe("电池");
    expect(slugifyEntityName("官网")).toBe("官网");
    expect(slugifyEntityName("电动越野摩托车")).toBe("电动越野摩托车");
  });

  test("空格 → 单连字符；大小写归一", () => {
    expect(slugifyEntityName("Soleil01 SE")).toBe("soleil01-se");
    expect(slugifyEntityName("Adria26")).toBe("adria26");
    expect(slugifyEntityName("  Battery  ")).toBe("battery");
  });

  test("重音折叠（NFD → 去组合符）", () => {
    expect(slugifyEntityName("café")).toBe("cafe");
    expect(slugifyEntityName("Nguyễn")).toBe("nguyen");
  });

  test("保留 . _ -，去掉其余标点", () => {
    expect(slugifyEntityName("Battery_Pack")).toBe("battery_pack");
    expect(slugifyEntityName("v1.2")).toBe("v1.2");
    expect(slugifyEntityName("Motor!")).toBe("motor");
    expect(slugifyEntityName("a/b")).toBe("ab");
  });

  test("剥离 .md 后缀；折叠连续连字符", () => {
    expect(slugifyEntityName("Battery.md")).toBe("battery");
    expect(slugifyEntityName("a - - b")).toBe("a-b");
  });

  test("空/纯标点 → 空串（调用方据此跳过）", () => {
    expect(slugifyEntityName("")).toBe("");
    expect(slugifyEntityName("!!!")).toBe("");
    expect(slugifyEntityName("   ")).toBe("");
  });
});

describe("stripCodeBlocks 镜像引擎语义", () => {
  test("围栏代码块被抹为等长空白", () => {
    const s = "before ```[[Battery]]``` after";
    expect(stripCodeBlocks(s).length).toBe(s.length);
    expect(stripCodeBlocks(s)).not.toContain("[[");
  });

  test("行内代码被抹；未闭合反引号保留", () => {
    expect(stripCodeBlocks("a `[[x]]` b")).not.toContain("[[");
    expect(stripCodeBlocks("a `b\nc` d")).toContain("`");
  });
});

describe("extractWikilinkTargets 双链扫描", () => {
  test("普通双链 → 规范化 slug + 原始标题", () => {
    const { targets } = extractWikilinkTargets("提到 [[Battery]] 与 [[Soleil01 SE]]。");
    expect(targets).toEqual([
      { slug: "battery", title: "Battery" },
      { slug: "soleil01-se", title: "Soleil01 SE" },
    ]);
  });

  test("别名语法取目标而非显示名", () => {
    expect(extractWikilinkTargets("[[Battery|电池]]")?.targets?.[0]).toEqual({ slug: "battery", title: "Battery" });
  });

  test("锚点被剥离", () => {
    expect(extractWikilinkTargets("[[Battery#Specs]]").targets[0]!.slug).toBe("battery");
  });

  test("代码块内双链不计入", () => {
    expect(extractWikilinkTargets("```\n[[Battery]]\n```").targets).toEqual([]);
  });

  test("同一目标的重复引用去重，保留首次出现的标题", () => {
    const { targets } = extractWikilinkTargets("[[Battery]] 和 [[battery]] 与 [[BATTERY]]");
    expect(targets).toHaveLength(1);
    expect(targets[0]).toEqual({ slug: "battery", title: "Battery" });
  });

  test("限定语法（含 :）与目录形态（含 /）跳过并计入 skipped", () => {
    const r = extractWikilinkTargets("[[wiki:topics/ai]] [[people/alice]] [[Battery]]");
    expect(r.targets.map((t) => t.slug)).toEqual(["battery"]);
    expect(r.skipped).toBe(2);
  });

  test("空文档 → 零目标零跳过", () => {
    expect(extractWikilinkTargets("")).toEqual({ targets: [], skipped: 0 });
  });
});

describe("分区判定", () => {
  test("isEntitySlug / isDocSlug 按 kb 前缀严格判定", () => {
    expect(isEntitySlug(KB, entitySlug(KB, "battery"))).toBe(true);
    expect(isDocSlug(KB, `${KB}/docs/a`)).toBe(true);
    expect(isEntitySlug(KB, `${KB}/docs/a`)).toBe(false);
    expect(isDocSlug(KB, `${KB}/entities/a`)).toBe(false);
    expect(isDocSlug("kb-other", `${KB}/docs/a`)).toBe(false);
  });
});

describe("missingEntityTargets 已存在页优先", () => {
  test("已有页不进候选（不覆盖用户页）", () => {
    const targets = [
      { slug: "battery", title: "Battery" },
      { slug: "motor", title: "Motor" },
    ];
    const existing = new Set([entitySlug(KB, "battery")]);
    expect(missingEntityTargets(KB, targets, existing).map((t) => t.slug)).toEqual(["motor"]);
  });

  test("同 slug 不同 kb 不算已存在", () => {
    const existing = new Set([entitySlug("kb-other", "battery")]);
    expect(missingEntityTargets(KB, [{ slug: "battery", title: "Battery" }], existing)).toHaveLength(1);
  });
});

describe("selectReclaimCandidates 回收护栏（纯决策）", () => {
  test("只保留 entities/ 分区的孤儿", () => {
    const r = selectReclaimCandidates(KB, [`${KB}/entities/battery`, `${KB}/docs/a`, "other/entities/x"]);
    expect(r.candidates).toEqual([`${KB}/entities/battery`]);
    expect(r.aborted).toBeNull();
  });

  test("本次文档引用的实体成为孤儿 ⇒ 放弃回收（graph_incomplete）", () => {
    const orphan = `${KB}/entities/battery`;
    const r = selectReclaimCandidates(KB, [orphan], new Set([orphan]));
    expect(r.aborted).toBe("graph_incomplete");
  });

  test("无关孤儿不受本次文档引用集影响", () => {
    const r = selectReclaimCandidates(KB, [`${KB}/entities/motor`], new Set([`${KB}/entities/battery`]));
    expect(r.aborted).toBeNull();
    expect(r.candidates).toHaveLength(1);
  });

  test("无候选 → 空且不中止", () => {
    expect(selectReclaimCandidates(KB, ["", "x/y"])).toEqual({ candidates: [], aborted: null });
  });
});

describe("hasEntityMarkerIn 来源标记识别", () => {
  test("带标记（裸值与引号值均识别）", () => {
    expect(hasEntityMarkerIn(`---\ntitle: Battery\nauto_generated: wikilink-stub\n---\n# B`)).toBe(true);
    expect(hasEntityMarkerIn(`---\ntitle: B\nauto_generated: "wikilink-stub"\n---\n`)).toBe(true);
  });

  test("无标记 → false（用户自建页）", () => {
    expect(hasEntityMarkerIn("---\ntitle: Battery\ntype: concept\n---\n")).toBe(false);
  });

  test("标记出现在正文而非 frontmatter → false（防伪造）", () => {
    expect(hasEntityMarkerIn("---\ntitle: B\n---\n\nauto_generated: wikilink-stub")).toBe(false);
  });
});

// ─── 服务层：注入 exec ─────────────────────────────────────────

interface FakeCalls {
  importDirs: string[][];
  deleted: string[];
  configSets: string[][];
}

function fakeService(handlers: {
  list?: string;
  orphans?: unknown;
  get?: (slug: string) => string | Error;
}): { svc: EntityGraphService; calls: FakeCalls } {
  const calls: FakeCalls = { importDirs: [], deleted: [], configSets: [] };
  const exec: CliExec = async (inv) => {
    const a = inv.args;
    const stdout = (s: string) => ({ stdout: s, stderr: "", exitCode: 0 });
    if (a[0] === "list") return stdout(handlers.list ?? "");
    if (a[0] === "orphans") return stdout(JSON.stringify(handlers.orphans ?? { orphans: [] }));
    if (a[0] === "get") {
      const r = handlers.get?.(a[1]!) ?? "";
      if (r instanceof Error) throw r;
      return stdout(r);
    }
    if (a[0] === "import") {
      calls.importDirs.push(readdirSync(a[1]!) as unknown as string[]);
      return stdout("imported 1");
    }
    if (a[0] === "delete") {
      calls.deleted.push(a[1]!);
      return stdout("");
    }
    if (a[0] === "config") {
      calls.configSets.push(a);
      return stdout("");
    }
    return stdout("");
  };
  return { svc: new EntityGraphService(cfg, { exec }), calls };
}

describe("EntityGraphService.ensureEntityPages（注入 exec）", () => {
  test("只为缺失目标建页，已存在的跳过", async () => {
    const { svc, calls } = fakeService({ list: `${entitySlug(KB, "battery")}\tconcept\n` });
    const r = await svc.ensureEntityPages(KB, [
      { slug: "battery", title: "Battery" },
      { slug: "motor", title: "Motor" },
    ]);
    expect(r.created).toEqual([entitySlug(KB, "motor")]);
    expect(r.existing).toBe(1);
    expect(calls.importDirs).toHaveLength(1);
  });

  test("无缺失目标 → 不触发 import", async () => {
    const { svc, calls } = fakeService({ list: `${entitySlug(KB, "battery")}\tconcept\n` });
    const r = await svc.ensureEntityPages(KB, [{ slug: "battery", title: "Battery" }]);
    expect(r.created).toEqual([]);
    expect(calls.importDirs).toHaveLength(0);
  });

  test("空目标集 → 直接返回，不调引擎", async () => {
    const { svc, calls } = fakeService({});
    const r = await svc.ensureEntityPages(KB, []);
    expect(r).toEqual({ created: [], existing: 0 });
    expect(calls.importDirs).toHaveLength(0);
  });
});

describe("EntityGraphService.reconcileEntityStubs 护栏（注入 exec）", () => {
  test("带标记的孤儿被回收", async () => {
    const orphan = entitySlug(KB, "battery");
    const { svc, calls } = fakeService({
      orphans: { orphans: [{ slug: orphan }] },
      get: () => `---\ntitle: Battery\ntype: ${ENTITY_TYPE}\nauto_generated: wikilink-stub\n---\n`,
    });
    const r = await svc.reconcileEntityStubs(KB);
    expect(r.reclaimed).toEqual([orphan]);
    expect(calls.deleted).toEqual([orphan]);
  });

  test("无来源标记（用户自建页）→ 不删", async () => {
    const orphan = entitySlug(KB, "mine");
    const { svc, calls } = fakeService({
      orphans: { orphans: [{ slug: orphan }] },
      get: () => `---\ntitle: Mine\ntype: ${ENTITY_TYPE}\n---\n`,
    });
    const r = await svc.reconcileEntityStubs(KB);
    expect(r.reclaimed).toEqual([]);
    expect(calls.deleted).toEqual([]);
  });

  test("读页失败 → fail-closed 不删", async () => {
    const orphan = entitySlug(KB, "battery");
    const { svc, calls } = fakeService({
      orphans: { orphans: [{ slug: orphan }] },
      get: () => new Error("page_not_found"),
    });
    const r = await svc.reconcileEntityStubs(KB);
    expect(calls.deleted).toEqual([]);
    expect(r.reclaimed).toEqual([]);
  });

  test("共享实体页（有存活入边）不会出现在孤儿列表 → 不删", async () => {
    const { svc, calls } = fakeService({ orphans: { orphans: [] } });
    const r = await svc.reconcileEntityStubs(KB);
    expect(r.candidates).toBe(0);
    expect(calls.deleted).toEqual([]);
  });

  test("本次文档引用的实体成为孤儿 ⇒ 中止且不删任何页", async () => {
    const orphan = entitySlug(KB, "battery");
    const other = entitySlug(KB, "motor");
    const { svc, calls } = fakeService({
      orphans: { orphans: [{ slug: orphan }, { slug: other }] },
      get: () => `---\nauto_generated: wikilink-stub\n---\n`,
    });
    const r = await svc.reconcileEntityStubs(KB, { referencedByCurrentDoc: new Set([orphan]) });
    expect(r.aborted).toBe("graph_incomplete");
    expect(calls.deleted).toEqual([]);
  });

  test("非 entities/ 分区的孤儿被忽略（不会误删文档）", async () => {
    const { svc, calls } = fakeService({
      orphans: { orphans: [{ slug: `${KB}/docs/orphan-doc` }] },
      get: () => `---\nauto_generated: wikilink-stub\n---\n`,
    });
    const r = await svc.reconcileEntityStubs(KB);
    expect(r.candidates).toBe(0);
    expect(calls.deleted).toEqual([]);
  });
});

describe("EntityGraphService 其余", () => {
  test("ensureGlobalBasename 写入引擎配置", async () => {
    const { svc, calls } = fakeService({});
    await svc.ensureGlobalBasename();
    expect(calls.configSets[0]).toEqual(["config", "set", "link_resolution.global_basename", "true"]);
  });

  test("runLinkExtraction 解析计数", async () => {
    const exec: CliExec = async (inv) => {
      if (inv.args.includes("--json")) {
        return {
          stdout: JSON.stringify({
            links_created: 7,
            skipped_missing_target: 3,
            skipped_cross_source: 1,
            pages_processed: 12,
          }),
          stderr: "",
          exitCode: 0,
        };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const svc = new EntityGraphService(cfg, { exec });
    expect(await svc.runLinkExtraction(KB)).toEqual({
      linksCreated: 7,
      skippedMissing: 3,
      skippedCrossSource: 1,
      pagesProcessed: 12,
    });
  });

  test("reclaimAfterDocDelete 先提取后回收", async () => {
    const order: string[] = [];
    const orphan = entitySlug(KB, "battery");
    const exec: CliExec = async (inv) => {
      const a = inv.args;
      if (a[0] === "extract") {
        order.push("extract");
        return { stdout: JSON.stringify({ links_created: 0 }), stderr: "", exitCode: 0 };
      }
      if (a[0] === "orphans") {
        order.push("orphans");
        return { stdout: JSON.stringify({ orphans: [{ slug: orphan }] }), stderr: "", exitCode: 0 };
      }
      if (a[0] === "get") {
        order.push("get");
        return { stdout: `---\nauto_generated: wikilink-stub\n---\n`, stderr: "", exitCode: 0 };
      }
      if (a[0] === "delete") {
        order.push("delete");
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const svc = new EntityGraphService(cfg, { exec });
    await svc.reclaimAfterDocDelete(KB);
    expect(order).toEqual(["extract", "orphans", "get", "delete"]);
  });

  test("常量与文档类型约定一致", () => {
    expect(DOC_TYPE).toBe("note");
    expect(ENTITY_TYPE).toBe("concept");
  });
});

describe("settleGraph 去抖（批量导入下 CLI 容量保护）", () => {
  const cfgSettle = loadConfig({
    ADMIN_TOKEN: "test-token-0123456789",
    DATABASE_URL: "postgres://stub@127.0.0.1:5/stub",
    DOCLING_URL: "",
    GRAPH_SETTLE_MS: "60000",
  } as Record<string, string>);

  function countingService() {
    const calls: string[] = [];
    const exec: CliExec = async (inv) => {
      calls.push(inv.args[0]!);
      if (inv.args.includes("--json")) {
        return { stdout: JSON.stringify({ links_created: 0, orphans: [] }), stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    return { svc: new EntityGraphService(cfgSettle, { exec }), calls };
  }

  test("同库第二次调用在窗口内跳过（不跑 extract/orphans）", async () => {
    const { svc, calls } = countingService();
    const a = await svc.settleGraph("kb-debounce-1");
    expect(a.skipped).toBe(false);
    const before = calls.length;
    const b = await svc.settleGraph("kb-debounce-1");
    expect(b.skipped).toBe(true);
    expect(calls.length).toBe(before); // 未产生任何 CLI 调用
  });

  test("不同库各自独立（互不抑制）", async () => {
    const { svc } = countingService();
    expect((await svc.settleGraph("kb-debounce-2")).skipped).toBe(false);
    expect((await svc.settleGraph("kb-debounce-3")).skipped).toBe(false);
  });

  test("窗口为 0 时不去抖（每次都跑）", async () => {
    const cfg0 = loadConfig({
      ADMIN_TOKEN: "test-token-0123456789",
      DATABASE_URL: "postgres://stub@127.0.0.1:5/stub",
      DOCLING_URL: "",
      GRAPH_SETTLE_MS: "0",
    } as Record<string, string>);
    const exec: CliExec = async (inv) => ({
      stdout: inv.args.includes("--json") ? JSON.stringify({ links_created: 0, orphans: [] }) : "",
      stderr: "",
      exitCode: 0,
    });
    const svc = new EntityGraphService(cfg0, { exec });
    expect((await svc.settleGraph("kb-debounce-4")).skipped).toBe(false);
    expect((await svc.settleGraph("kb-debounce-4")).skipped).toBe(false);
  });

  test("删除路径的回收不去抖（用户显式操作应即时生效）", async () => {
    const { svc, calls } = countingService();
    await svc.settleGraph("kb-debounce-5"); // 占住去抖窗口
    calls.length = 0;
    await svc.reclaimAfterDocDelete("kb-debounce-5");
    expect(calls).toContain("extract");
    expect(calls).toContain("orphans");
  });
});
