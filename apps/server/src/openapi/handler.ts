import type { RouteConfig, RouteHandler } from "@hono/zod-openapi";
import type { Context, Next } from "hono";
import type { Env } from "../middleware/auth";

/**
 * 库边界类型逃逸（项目规则允许的 as-unknown-as 场景）：
 * @hono/zod-openapi 的 Handler 泛型只收敛单一成功响应分支，业务处理器的
 * 多状态 JSONRespondReturn 联合（401/403/404/410/422…）无法直接赋值
 * （探针验证：单返回通过、多分支失败）。运行时行为与路由声明的各状态分支一致，
 * 此处仅做类型桥接，不改变任何行为。响应形状本身仍由路由声明中的 schema 描述。
 */
// eslint-disable-next-line
export function libHandler<R extends RouteConfig>(impl: (c: Context<Env>, next: Next) => unknown): RouteHandler<R, Env> {
  return impl as unknown as RouteHandler<R, Env>;
}
