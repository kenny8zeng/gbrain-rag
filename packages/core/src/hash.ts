import { createHash, randomBytes } from "node:crypto";

export function sha256hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export interface GeneratedKey {
  /** 明文，仅签发响应返回一次 */
  key: string;
  /** 入库哈希 */
  hash: string;
  /** 列表展示前缀 */
  prefix: string;
}

/** gbrag_<32hex>：CSPRNG 高熵串，SHA-256 入库即可（无需慢哈希） */
export function generateKey(): GeneratedKey {
  const hex = randomBytes(16).toString("hex");
  const key = `gbrag_${hex}`;
  return { key, hash: sha256hex(key), prefix: key.slice(0, 12) };
}
