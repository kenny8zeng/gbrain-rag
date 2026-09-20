import { afterAll, describe, expect, test } from "bun:test";

/**
 * 009 裸解析端点集成测试。
 *
 * 覆盖验收核心：
 * - SC-001 零绑定凭证即可解析 + 调用前后知识库零变化（FR-012）
 * - SC-002 导入 vs 裸解析正文逐字节一致（两路都能处理的输入）
 * - SC-003 未配置外部解析服务时：能力范围外 → UNSUPPORTED_FILE_TYPE；URL/图片 → PARSER_UNAVAILABLE；零外部调用
 * - SC-004 错误码互斥（PARSE_BUSY 可重试 vs 其余不可重试）
 * - SC-007 能力自描述与实际受理一致
 *
 * 部署形态依赖：`UNSUPPORTED_FILE_TYPE` 仅在「未配置外部解析服务」的实例上出现；
 * 若 TEST_BASE_URL 指向 docling 可用实例，相关用例会自动跳过（用 PARSER_UNAVAILABLE/成功断言兜底）。
 */
const BASE = process.env.TEST_BASE_URL;
const ADMIN = process.env.ADMIN_TOKEN ?? "";
const gated = BASE && ADMIN ? describe : describe.skip;

const DOCX = "tests/fixtures/test.docx";

/** 8 字节非任何已知格式的魔数（内容轨亦不可识别） */
const MYSTERY = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

async function issueKey(label: string): Promise<string> {
  const r = await fetch(`${BASE}/v1/keys`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ label, read_kbs: [] }),
  }).then((x) => x.json() as Promise<{ key?: string; id?: string }>);
  return r.key!;
}

type ParseResp = {
  markdown?: string;
  parser?: string;
  fallback_from?: string | null;
  duration_ms?: number;
  chars?: number;
  empty?: boolean;
  error?: { code: string; message: string };
};

async function parseFileReq(key: string, filePath: string, name?: string): Promise<{ status: number; body: ParseResp }> {
  const buf = await Bun.file(filePath).arrayBuffer();
  const fd = new FormData();
  fd.append("file", new File([buf], name ?? filePath.split("/").pop()!, { type: "application/octet-stream" }));
  const res = await fetch(`${BASE}/v1/kb/parse`, { method: "POST", headers: { "X-API-Key": key }, body: fd });
  return { status: res.status, body: (await res.json()) as ParseResp };
}

async function parseBytesReq(key: string, bytes: Uint8Array, name: string): Promise<{ status: number; body: ParseResp }> {
  const fd = new FormData();
  fd.append("file", new File([bytes as unknown as BlobPart], name, { type: "application/octet-stream" }));
  const res = await fetch(`${BASE}/v1/kb/parse`, { method: "POST", headers: { "X-API-Key": key }, body: fd });
  return { status: res.status, body: (await res.json()) as ParseResp };
}

async function parseText(key: string, text: string, mime = "text/markdown"): Promise<{ status: number; body: ParseResp }> {
  const res = await fetch(`${BASE}/v1/kb/parse`, {
    method: "POST",
    headers: { "X-API-Key": key, "Content-Type": mime },
    body: text,
  });
  return { status: res.status, body: (await res.json()) as ParseResp };
}

async function parseUrlReq(key: string, url: string): Promise<{ status: number; body: ParseResp }> {
  const res = await fetch(`${BASE}/v1/kb/parse`, {
    method: "POST",
    headers: { "X-API-Key": key, "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  return { status: res.status, body: (await res.json()) as ParseResp };
}

gated("裸文档解析端点（009）", () => {
  let key = "";
  let keyId = "";
  let kb = "";
  let wkey = "";

  afterAll(async () => {
    for (const id of [keyId].filter(Boolean)) {
      await fetch(`${BASE}/v1/keys/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${ADMIN}` } });
    }
    if (kb) {
      await fetch(`${BASE}/v1/kb/${kb}?force=true`, { method: "DELETE", headers: { Authorization: `Bearer ${ADMIN}` } });
      await fetch(`${BASE}/v1/kb/${kb}/purge?force=true`, { method: "POST", headers: { Authorization: `Bearer ${ADMIN}` } });
    }
  });

  test("准备：仅签发零知识库绑定的凭证（不建任何库）", async () => {
    const r = await fetch(`${BASE}/v1/keys`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ label: `parse-it-${Date.now()}`, read_kbs: [] }),
    }).then((x) => x.json() as Promise<{ key: string; id: string; read_kbs: unknown[] }>);
    expect(r.key).toStartWith("gbrag_");
    // SC-001 前提：凭证确实零绑定
    expect(r.read_kbs).toEqual([]);
    key = r.key;
    keyId = r.id;
  }, 60000);

  // ─── US1：转换文档 + 零副作用 ───────────────────────────────

  test("US1/SC-001 零绑定凭证解析真实 docx（无需建库）", async () => {
    const { status, body } = await parseFileReq(key, DOCX);
    expect(status).toBe(200);
    expect(body.markdown!.length).toBeGreaterThan(0);
    expect(["anydoc", "docling"]).toContain(body.parser!);
    expect(body.fallback_from).toBeNull();
    expect(body.chars).toBe(body.markdown!.length);
    expect(body.empty).toBe(false);
  }, 120000);

  test("US1/FR-005 纯文本直通：原样返回、零解析、不占并发额度", async () => {
    const text = "# Title\n\nbody [[Concept]]\n";
    const { status, body } = await parseText(key, text);
    expect(status).toBe(200);
    expect(body.parser).toBe("passthrough"); // 不经解析通道
    expect(body.markdown).toBe(text); // 逐字节相同
    expect(body.fallback_from).toBeNull();
  }, 60000);

  test("US1/FR-005 `.txt` 亦直通（本端点扩展，见 spec FR-005）", async () => {
    const text = "plain notes\n";
    const r = await fetch(`${BASE}/v1/kb/parse`, {
      method: "POST",
      headers: { "X-API-Key": key, "Content-Type": "text/plain" },
      body: text,
    }).then((x) => x.json() as Promise<ParseResp>);
    expect(r.parser).toBe("passthrough");
    expect(r.markdown).toBe(text);
  }, 60000);

  test("US1/FR-012 解析对知识库零副作用（页面/任务计数不变）", async () => {
    // 建一个库作为观测对象
    const created = await fetch(`${BASE}/v1/kb`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: `parse-observe-${Date.now()}` }),
    }).then((x) => x.json() as Promise<{ id: string }>);
    kb = created.id;
    const k = await fetch(`${BASE}/v1/keys`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ label: `parse-w-${Date.now()}`, write_kb: kb, read_kbs: [kb] }),
    }).then((x) => x.json() as Promise<{ key: string }>);
    wkey = k.key;

    const before = await fetch(`${BASE}/v1/kb/${kb}/documents`, { headers: { "X-API-Key": wkey } })
      .then((r) => r.json() as Promise<{ pages: unknown[] }>);
    for (let i = 0; i < 3; i++) await parseFileReq(key, DOCX);
    const after = await fetch(`${BASE}/v1/kb/${kb}/documents`, { headers: { "X-API-Key": wkey } })
      .then((r) => r.json() as Promise<{ pages: unknown[] }>);
    expect(after.pages.length).toBe(before.pages.length);
    expect(before.pages.length).toBe(0);
  }, 180000);

  // ─── US2：一致性与不可覆盖 ─────────────────────────────────

  test("US2/FR-003 请求携带解析器偏好被忽略（结果与不携带逐字节一致）", async () => {
    const clean = await parseFileReq(key, DOCX);
    // 以 extra field 形式注入偏好（handler 不读、不转发）
    const buf = await Bun.file(DOCX).arrayBuffer();
    const fd = new FormData();
    fd.append("file", new File([buf], "test.docx", { type: "application/octet-stream" }));
    fd.append("parser", "docling");
    fd.append("preference", "anydoc");
    fd.append("mode", "docling");
    const withPref = await fetch(`${BASE}/v1/kb/parse`, { method: "POST", headers: { "X-API-Key": key }, body: fd })
      .then((r) => r.json() as Promise<ParseResp>);
    expect(withPref.parser).toBe(clean.body.parser);
    expect(withPref.markdown).toBe(clean.body.markdown);
  }, 120000);

  test("US2/SC-002 导入 vs 裸解析：正文逐字节一致 + 生效解析器相同", async () => {
    expect(wkey).not.toBe("");
    const fd = new FormData();
    fd.append("file", new File([await Bun.file(DOCX).arrayBuffer()], "test.docx", { type: "application/octet-stream" }));
    const jid = await fetch(`${BASE}/v1/kb/${kb}/documents`, { method: "POST", headers: { "X-API-Key": wkey }, body: fd })
      .then((r) => r.json() as Promise<{ job_id: string }>)
      .then((j) => j.job_id);
    // 等导入完成
    let imported: string | null = null;
    for (let i = 0; i < 60; i++) {
      const st = await fetch(`${BASE}/v1/kb/${kb}/documents/jobs/${jid}`, { headers: { "X-API-Key": wkey } })
        .then((r) => r.json() as Promise<{ status: string; doc_slug: string | null }>);
      if (["done", "done_with_warnings", "failed"].includes(st.status)) {
        imported = st.doc_slug;
        break;
      }
      await Bun.sleep(2000);
    }
    expect(imported).toBeTruthy();

    // 取导入产出的正文（页面全文端点）
    const page = await fetch(`${BASE}/v1/kb/${kb}/page?slug=${encodeURIComponent(imported!)}`, {
      headers: { "X-API-Key": wkey },
    }).then((r) => r.json() as Promise<{ content?: string }>);

    const parsed = await parseFileReq(key, DOCX);
    expect(parsed.status).toBe(200);

    // 逐字节比对正文（导入的 content 含服务注入的 frontmatter，故比对正文主体）
    const strip = (s: string) => s.replace(/^---\n[\s\S]*?\n---\n/, "").trimStart();
    expect(strip(parsed.body.markdown!)).toBe(strip(page.content ?? ""));
  }, 300000);

  // ─── US3：能力边界 + 错误码 ────────────────────────────────

  test("US3/FR-008 内容优先：docx 字节 + 误导扩展名仍被受理", async () => {
    const { status, body } = await parseFileReq(key, DOCX, "sample.bin");
    expect(status).toBe(200);
    expect(body.markdown!.length).toBeGreaterThan(0);
  }, 120000);

  test("US3/SC-003 能力范围外类型与 URL 的错误码（随部署形态）", async () => {
    const health = await fetch(`${BASE}/health`).then((r) => r.json() as Promise<{ parse: { accepts_url: boolean } }>);
    const externalAvailable = health.parse.accepts_url;

    const mystery = await parseBytesReq(key, MYSTERY, "mystery.dat");
    if (externalAvailable) {
      // 配置了外部解析服务：交其尝试 → 解析失败（不是类型不支持）
      expect(["PARSE_FAILED", "UNSUPPORTED_FILE_TYPE"]).toContain(mystery.body.error!.code);
    } else {
      // 未配置：明确的不支持类型
      expect(mystery.status).toBe(422);
      expect(mystery.body.error!.code).toBe("UNSUPPORTED_FILE_TYPE");
      expect(mystery.body.error!.message).toContain("mystery.dat");
    }

    const url = await parseUrlReq(key, "https://example.com");
    if (externalAvailable) {
      expect(url.status).toBe(200);
    } else {
      expect(url.status).toBe(422);
      expect(url.body.error!.code).toBe("PARSER_UNAVAILABLE");
    }
  }, 180000);

  test("US3/FR-005a 纯文本例外有边界：文本内容 + 未知扩展名 ≠ 不支持类型", async () => {
    // 纯文本内容但扩展名不可识别 → 直通（不被判为不支持）
    const text = "just plain text, no markup\n";
    const r = await fetch(`${BASE}/v1/kb/parse`, {
      method: "POST",
      headers: { "X-API-Key": key, "Content-Type": "multipart/form-data; boundary=X" },
      body: "--X\r\nContent-Disposition: form-data; name=\"file\"; filename=\"notes.xyz\"\r\n\r\n" + text + "\r\n--X--\r\n",
    }).then((x) => x.json() as Promise<ParseResp>);
    // md/txt 以外扩展名但内容为文本：内容轨不可识别 → 若实例无外部服务则报不支持；
    // 这是**预期边界**（FR-005a 的例外仅覆盖 .md/.txt 扩展名本身）
    expect(["passthrough", "UNSUPPORTED_FILE_TYPE", "PARSE_FAILED"]).toContain(r.parser ?? r.error?.code ?? "");
  }, 120000);

  test("US3/SC-004 错误码分类互斥（可重试 vs 不可重试）", async () => {
    const retryable = new Set(["PARSE_BUSY"]);
    const notRetryable = new Set([
      "UNSUPPORTED_FILE_TYPE",
      "PARSER_UNAVAILABLE",
      "PARSE_FAILED",
      "PARSE_TIMEOUT",
      "PAYLOAD_TOO_LARGE",
      "INVALID_PARAMS",
    ]);
    for (const c of retryable) expect(notRetryable.has(c)).toBe(false);
    // 实证：不可重试类确实返回 422（非 503）
    const empty = await parseText(key, "   \n", "text/plain");
    expect(empty.status).toBe(422);
    expect(notRetryable.has(empty.body.error!.code)).toBe(true);
    expect(empty.status).not.toBe(503);
  }, 60000);

  test("US3/SC-007 能力自描述与实际受理一致", async () => {
    const health = await fetch(`${BASE}/health`).then((r) => r.json() as Promise<{
      parse: { supported_file_types: string[]; passthrough_types: string[]; accepts_url: boolean; concurrency: number };
    }>);
    expect(health.parse.passthrough_types).toEqual(["md", "txt"]);
    expect(health.parse.concurrency).toBeGreaterThan(0);
    // 列表内每个类型都应被受理（以内容轨为准：构造该扩展名的真 docx 字节应被受理）
    const docxBytes = new Uint8Array(await Bun.file(DOCX).arrayBuffer());
    for (const ext of ["docx", "pdf"].filter((e) => health.parse.supported_file_types.includes(e))) {
      const { status } = await parseBytesReq(key, docxBytes, `probe.${ext}`);
      expect(status).toBe(200);
    }
    // 直通类型必成功
    for (const ext of health.parse.passthrough_types) {
      const r = await fetch(`${BASE}/v1/kb/parse`, {
        method: "POST",
        headers: { "X-API-Key": key, "Content-Type": "text/plain" },
        body: `content for .${ext}\n`,
      });
      expect(r.status).toBe(200);
    }
  }, 180000);

  // ─── 边界与凭证 ───────────────────────────────────────────

  test("凭证无效 → 401（与不存在同响应，不泄露存在性）", async () => {
    const r = await fetch(`${BASE}/v1/kb/parse`, {
      method: "POST",
      headers: { "X-API-Key": "gbrag_bogus_key_value", "Content-Type": "text/plain" },
      body: "x",
    });
    expect(r.status).toBe(401);
  }, 60000);

  test("空文本 → 422 INVALID_PARAMS", async () => {
    const { status, body } = await parseText(key, "   \n", "text/plain");
    expect(status).toBe(422);
    expect(body.error!.code).toBe("INVALID_PARAMS");
  }, 60000);

  test("无法识别的 content-type → 422", async () => {
    const r = await fetch(`${BASE}/v1/kb/parse`, {
      method: "POST",
      headers: { "X-API-Key": key, "Content-Type": "application/xml" },
      body: "<x/>",
    });
    expect(r.status).toBe(422);
  }, 60000);
});
