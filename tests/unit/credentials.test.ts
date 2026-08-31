import { describe, expect, test } from "bun:test";
import { generateKey, sha256hex } from "../../packages/core/src/hash";
import { buildRegisterArgs, buildRescopeArgs } from "../../packages/core/src/credentials";

describe("generateKey", () => {
  test("格式与哈希一致性", () => {
    const g = generateKey();
    expect(g.key).toMatch(/^gbrag_[0-9a-f]{32}$/);
    expect(g.hash).toBe(sha256hex(g.key));
    expect(g.prefix).toBe(g.key.slice(0, 12));
    expect(g.key).not.toBe(generateKey().key);
  });
});

describe("buildRegisterArgs", () => {
  test("写分区：slug 栅栏 + 全权限", () => {
    const args = buildRegisterArgs({ clientName: "rag-abc123", writeKb: "kb-aabbccdd", readKbs: ["kb-aabbccdd", "kb-11223344"] });
    expect(args).toContain("--source");
    expect(args[args.indexOf("--source") + 1]).toBe("kb-aabbccdd");
    expect(args[args.indexOf("--federated-read") + 1]).toBe("kb-aabbccdd,kb-11223344");
    expect(args).toContain("--bound-slug-prefixes");
    expect(args).not.toContain("--scopes");
  });
  test("纯读：--scopes read，无栅栏", () => {
    const args = buildRegisterArgs({ clientName: "rag-abc123", writeKb: null, readKbs: ["kb-aabbccdd"] });
    expect(args).toContain("--scopes");
    expect(args[args.indexOf("--scopes") + 1]).toBe("read");
    expect(args).not.toContain("--bound-slug-prefixes");
  });
});

describe("buildRescopeArgs", () => {
  test("仅传变更轴", () => {
    const args = buildRescopeArgs("gbrain_cl_x", { readKbs: ["kb-aabbccdd"] });
    expect(args).toEqual(["auth", "rescope-client", "gbrain_cl_x", "--federated-read", "kb-aabbccdd"]);
  });
});
