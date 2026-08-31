/**
 * 跨域来源匹配（纯函数，spec FR-003）：
 * - 列表为空 → 特性关闭（任何请求都返回 null，不产生跨域头）
 * - "*" → 全放行（返回 "*"）
 * - 精确匹配（scheme://host[:port]，路径/尾斜杠由浏览器 Origin 语义忽略）
 */
export function matchOrigin(origins: string[], requestOrigin: string | null): string | null {
  if (origins.length === 0 || requestOrigin === null) return null;
  if (origins.includes("*")) return "*";
  const normalized = requestOrigin.replace(/\/$/, "");
  return origins.some((o) => o === normalized) ? normalized : null;
}
