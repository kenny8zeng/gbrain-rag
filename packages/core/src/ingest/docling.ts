import type { Config } from "../config";

export interface ConvertResult {
  md: string;
  status: string;
}

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

interface DoclingDocument {
  md_content?: string;
}

interface DoclingResponse {
  document?: DoclingDocument;
  status?: string;
  errors?: Array<{ error?: string }>;
}

function errBody(res: Response): Promise<string> {
  return res.text().then((t) => t.slice(0, 500));
}

/** 文件/图片 → MD（multipart files + to_formats=md），600s 级超时由 cfg.JOB_TIMEOUT_MS 控制 */
export async function convertFileBytes(
  cfg: Config,
  bytes: Uint8Array,
  filename: string,
  fetchImpl: FetchImpl = fetch,
): Promise<ConvertResult> {
  const form = new FormData();
  form.append("files", new Blob([new Uint8Array(bytes)], { type: "application/octet-stream" }), filename);
  form.append("to_formats", "md");
  form.append("do_ocr", "true");
  const res = await fetchImpl(`${cfg.DOCLING_URL}/v1/convert/file`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(cfg.JOB_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`docling convert/file ${res.status}: ${await errBody(res)}`);
  const j = (await res.json()) as DoclingResponse;
  const md = j.document?.md_content ?? "";
  if (!md.trim()) throw new Error(`docling returned empty markdown (status=${j.status ?? "unknown"})`);
  return { md, status: j.status ?? "unknown" };
}

/** 网页 URL → MD（POST /v1/convert/source；spec FR-013：不做地址校验） */
export async function convertWebUrl(
  cfg: Config,
  url: string,
  fetchImpl: FetchImpl = fetch,
): Promise<ConvertResult> {
  const res = await fetchImpl(`${cfg.DOCLING_URL}/v1/convert/source`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sources: [{ kind: "http", url }],
      options: { to_formats: ["md"], do_ocr: true },
    }),
    signal: AbortSignal.timeout(cfg.JOB_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`docling convert/source ${res.status}: ${await errBody(res)}`);
  const j = (await res.json()) as DoclingResponse;
  const md = j.document?.md_content ?? "";
  if (!md.trim()) throw new Error(`docling returned empty markdown (status=${j.status ?? "unknown"})`);
  return { md, status: j.status ?? "unknown" };
}
