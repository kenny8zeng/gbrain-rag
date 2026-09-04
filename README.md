# gbrain-rag

**English** · [中文](README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun-%23fbf0df)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue)](https://www.typescriptlang.org)

A **RAG knowledge base service** built on [GBrain](https://github.com/garrytan/gbrain): give many AI agents / applications a shared private knowledge base without building the ingestion pipeline, permission model, and model wiring yourself.

## What problem it solves

Rolling your own RAG service means tripping over the same three pits:

| Pit | DIY burden | gbrain-rag approach |
|---|---|---|
| **Isolation & authorization for shared KBs** | Design a permission model, filter retrieval per partition, prevent escalation | One key per agent: **write partition + read grants** pinned at issuance, engine-level hard isolation (request params cannot bypass); revocation is **immediate**; cross-partition retrieval merges automatically |
| **Document ingestion pipeline** | Integrate parsers, handle format failures, retry/resume | Files/images/URLs/Markdown out of the box: **dual-parser automatic fallback** (docling + built-in millisecond anydoc), failed conversions switch lanes automatically, async jobs retry 3× |
| **Model wiring** | Research vendor endpoints/interfaces, trip on allowlists | Fill in three lines per capability — OpenAI-compatible **endpoint + model + key**; dimensions and interface shape are auto-probed; config errors fail fast at setup (no "looks fine, breaks at runtime") |

## Highlights

- **Agent-native**: built-in MCP gateway — Claude-class agents read/write the KB with one key over `POST /mcp`; isolation travels with the credential, no middleware needed
- **Safe credential model**: plaintext key returned exactly once at issuance, DB stores only hashes; revoked keys are indistinguishable from nonexistent ones (no existence leaks); unauthorized access is 403 without existence hints; per-key concurrency gate
- **Ingest what you have**: docx/PDF/Office/images/URL/Markdown → structured pages + vector index, upsert overwrite with version history; hosted OCR for scans
- **Nine lines configure all models**: chat/embedding/rerank × (`*_BASE_URL` + `*_MODEL` + `*_API_KEY`); switching vendors = editing three lines; any OpenAI-compatible service works (DashScope/OpenRouter/DeepSeek/OpenAI…)
- **One command to start**: single image + `docker compose up`; only Postgres and (optional) docling are external
- **Fully executable contract**: Swagger UI with credential entry (run calls online), drift-free OpenAPI (CI gate), 55 engine ops also exposed as documented routes
- **Observable**: `/health` surfaces parser/model/upstream state; retrieval degradations carry explicit `degraded` reasons
- **Knowledge-graph upkeep (optional)**: enable the dream cycle to auto-extract page relations into the graph (light tier, no LLM); admin API for manual triggers with run-exclusivity

## Architecture

A single-image Bun process (unified router + MCP gateway + ingest worker) supervising `gbrain serve --http` (loopback only); external dependencies are Postgres (pgvector) and docling-serve.

```text
AI Agent ──X-API-Key──▶ ┌──────────────────────────────┐
Apps     ──X-API-Key──▶ │ gbrain-rag (Bun)             │ ──▶ docling-serve (docs/images/URL → MD)
Admin    ──Bearer─────▶ │  Hono unified router         │ ──▶ Postgres + pgvector
                        │  MCP gateway → gbrain serve  │
                        │  ingest worker → gbrain CLI  │
                        └──────────────────────────────┘
```

- **Knowledge base (KB)** = a gbrain source; `POST /v1/kb` auto-provisions (directory + git + sources add)
- **Agent credentials** = one gbrain OAuth client per key: a single write partition (`--source` + slug fence) and a pre-approved federated-read list (`--federated-read`), cross-source retrieval merged automatically (engine-side hard isolation — see `specs/001-gbrain-rag-service/research.md` D2)
- **Ingestion**: files (incl. images) / web URLs / direct Markdown → parser conversion → one document per page → gbrain chunking + embed; async job table with 3 retries
  - **Parser selection**: `DOCLING_URL` set → dual parsers: `PARSER_PREFERENCE=docling` (default; automatic fallback to anydoc) or `=anydoc` (millisecond local; falls back to docling); URLs/images always use docling. Empty → built-in anydoc only (URLs/standalone images rejected with guidance). `PARSER_MODE` forces a single parser (testing/troubleshooting, no fallback); scanned PDFs use `FIRECRAWL_API_KEY` + `ANYDOC_OCR=on` for hosted OCR
- **Admin proxy**: `/v1/admin/gbrain/*` exposes the full gbrain CLI via cli2api (git dependency, zero source changes); read-only status routes support `?format=json`

## Quick start

```bash
cd deploy
cp .env.example .env      # set ADMIN_TOKEN; optionally DOCLING_URL / EMBEDDING / RERANKER
docker compose up -d --build
curl localhost:3000/health
```

End-to-end verification walkthrough: `specs/001-gbrain-rag-service/quickstart.md`.

## API surface

| Plane | Auth | Highlights |
|---|---|---|
| Admin | `Authorization: Bearer $ADMIN_TOKEN` | `POST/GET /v1/kb`, `DELETE /v1/kb/:id`, `POST/PATCH/DELETE /v1/keys`, `GET /v1/jobs`, `/v1/admin/gbrain/*` |
| Tenant | `X-API-Key: gbrag_...` | `POST /v1/kb/:id/documents`, `GET/DELETE .../documents/:slug`, `POST /v1/kb/:id/retrieval`, `POST /mcp` |


## API docs

- `GET /openapi.json` — service OpenAPI description (tenant/admin planes, dual auth schemes)
- `GET /v1/admin/openapi/gbrain.json` — engine admin-proxy description (55 routes)
- `GET /docs` — self-hosted interactive docs (grouped, credential entry for online execution, zero external network)
- Docs are drift-free against registered routes: `tests/contract/openapi-drift.test.ts` gates CI

Full contracts: `specs/001-gbrain-rag-service/contracts/`, `specs/003-openapi-swagger-ui/contracts/docs-api.md`.

## Environment variables

See `deploy/.env.example`.

> ⚠️ **Security note (spec FR-013)**: URL import performs **no address validation** (SSRF risk is carried by caller input and the deployment boundary). This service must be deployed in a trusted environment isolated from sensitive internals; if publicly exposed, tighten this policy first and add network-layer protection.

## Development

```bash
bun install
bun test tests/unit                 # unit tests (no external deps)
TEST_BASE_URL=http://localhost:3000 ADMIN_TOKEN=... bun test tests/contract   # contract (needs a running instance)
bun test tests/integration          # full integration (needs the compose stack)
```

Code layout: `apps/server` (assembly/supervisor/worker/routes) + `packages/core` (domain modules, no HTTP dependency).

## Documentation

### Getting started

| Doc | Contents |
|---|---|
| [docs/deployment.md](docs/deployment.md) | **Deployment**: architecture / full env table / persistence & backup / upgrades / troubleshooting |
| [docs/usage.md](docs/usage.md) | **Usage**: concept model / API planes / ingest & retrieval / MCP / error-code quick reference |
| [docs/examples.md](docs/examples.md) | **Examples**: copy-paste sessions (KB → credentials → ingest → retrieval → permissions → deletion) |
| [docs/auth-model.md](docs/auth-model.md) | **Auth model**: admin/tenant planes, credential lifecycle, upstream OAuth isolation, security properties |

### API & contracts

| Location/Doc | Contents |
|---|---|
| `GET /docs` | Swagger UI (service + engine proxy, executable online) |
| `GET /openapi.json` | Service OpenAPI description |
| [specs/](specs/) | Feature spec/plan/tasks (001 core, 002 CORS, 003 OpenAPI, 004 anydoc, 005 parser priority, 006 model config) |

### Engineering & community

| Doc | Contents |
|---|---|
| [docs/testing-strategy.md](docs/testing-strategy.md) | Testing: defect ledger, pyramid gates, four-instance matrix |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Contribution guide (architecture conventions/test discipline/commit rules) |
| [CHANGELOG.md](CHANGELOG.md) | Changelog (Keep a Changelog) |
| [SECURITY.md](SECURITY.md) | Security policy & vulnerability reporting |
| [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) | Contributor covenant |

## Published images (GitHub Actions)

Multi-arch (`linux/amd64`, `linux/arm64`) images are built automatically by [`.github/workflows/docker-multi-registry.yml`](.github/workflows/docker-multi-registry.yml) and published to two registries:

| Registry | Image |
|---|---|
| GHCR | `ghcr.io/kenny8zeng/gbrain-rag` |
| Docker Hub | `kenny8zeng/gbrain-rag` |

## License

[MIT](LICENSE) (Copyright (c) 2026 gbrain-rag contributors)
