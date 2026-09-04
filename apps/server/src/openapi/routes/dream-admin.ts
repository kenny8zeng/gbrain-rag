import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { Services } from "../../app";
import type { Env } from "../../middleware/auth";
import { libHandler } from "../handler";

type Admin = (c: Context<Env>, next: () => Promise<void>) => Promise<Response | void>;

const DreamTriggerBody = z.object({
  tier: z.enum(["light", "full"]).optional().describe("成本档（缺省用环境变量档位）"),
});

const DreamStatusView = z.object({
  enabled: z.boolean(),
  tier: z.enum(["light", "full"]),
  interval_hours: z.number(),
  running: z.boolean(),
  started_at: z.string().nullable(),
  next_due: z.string().nullable(),
  last_run: z
    .object({
      at: z.string(),
      ok: z.boolean(),
      tier: z.enum(["light", "full"]),
      summary: z.string(),
    })
    .nullable(),
  last_error: z.string().nullable(),
});

const DreamTriggerView = z.object({
  status: z.literal("started"),
  tier: z.enum(["light", "full"]),
  started_at: z.string(),
});

export function registerDreamAdminRoutes(app: OpenAPIHono<Env>, svc: Services, admin: Admin): void {
const triggerRoute = createRoute({
  method: "post",
  path: "/v1/admin/dream",
  tags: ["admin"],
  summary: "手工触发一次梦境周期（运行中返回 409）",
  middleware: [admin],
  security: [{ adminToken: [] }],
  request: { body: { required: true, content: { "application/json": { schema: DreamTriggerBody } } } },
  responses: {
    202: { description: "已接受（异步执行）", content: { "application/json": { schema: DreamTriggerView } } },
    409: { description: "已有梦境周期在运行" },
  },
});

const statusRoute = createRoute({
  method: "get",
  path: "/v1/admin/dream",
  tags: ["admin"],
  summary: "梦境周期状态",
  middleware: [admin],
  security: [{ adminToken: [] }],
  responses: { 200: { description: "状态", content: { "application/json": { schema: DreamStatusView } } } },
});
  app.openapi(triggerRoute, libHandler<typeof triggerRoute>(async (c: Context<Env>) => {
    const parsed = DreamTriggerBody.safeParse(await c.req.json().catch(() => null));
    const tier = parsed.success && parsed.data.tier ? parsed.data.tier : undefined;
    const res = await svc.dream.start("manual", tier);
    if (!res.accepted) {
      return c.json(
        { error: { code: "DREAM_RUNNING", message: res.reason ?? "dream cycle already running" } },
        409,
      );
    }
    return c.json(
      { status: "started", tier: tier ?? svc.dream.status().tier, started_at: svc.dream.status().startedAt ?? new Date().toISOString() },
      202,
    );
  }));

  app.openapi(statusRoute, libHandler<typeof statusRoute>(async (c: Context<Env>) => {
    const st = svc.dream.status();
    return c.json({
      enabled: st.enabled,
      tier: st.tier,
      interval_hours: st.intervalHours,
      running: st.running,
      started_at: st.startedAt,
      next_due: st.nextDue,
      last_run: st.lastRun,
      last_error: st.lastError,
    });
  }));
}
