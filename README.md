# gbrain-rag

**English** · [中文](README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun-%23fbf0df)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue)](https://www.typescriptlang.org)

A **RAG knowledge base service** built on [GBrain](https://github.com/garrytan/gbrain): one entry point that unifies knowledge-partition management, multi-source document ingestion (dual parser — docling / anydoc with automatic fallback), REST retrieval, and an MCP gateway for AI agents.

## Features

- **Knowledge bases as isolated partitions** (GBrain sources): lifecycle via API, hard tenant isolation through per-credential OAuth clients (single write partition + pre-approved federated read list, enforced by the engine).
- **Document ingestion**: files (Office/PDF/images), web URLs, Markdown — async jobs with retry; upsert semantics; dedupe by page identity.
  - **Dual parser**: configure `DOCLING_URL` → docling (URL/image/OCR/complex layouts) with automatic fallback to built-in anydoc on failure (`PARSER_PREFERENCE` switches the priority); leave it empty → anydoc only (millisecond, in-process, offline-capable).
- **Retrieval**: REST (`hybrid` / `keyword`) and MCP — cross-partition search merged automatically within the credential's approved read list.
- **MCP gateway** (Streamable HTTP): agents manage content in their write partition and search across approved partitions; isolation cannot be bypassed via request parameters.
- **OpenAPI + self-hosted Swagger UI**: route definitions are the documentation source (zero-drift CI gate); engine ops surface (55 routes) as a third doc group.
- **Admin engine proxy**: full GBrain CLI operations over REST (SSE streaming, `?format=json` for status routes).

## Quick start

```bash
cd deploy
cp .env.example .env        # set ADMIN_TOKEN; DOCLING_URL optional (empty = anydoc)
docker compose up -d --build
curl localhost:3000/health
```

Guides: [Deployment](docs/deployment.md) · [Usage](docs/usage.md) · [Examples](docs/examples.md) (Chinese — the project's primary documentation language).

## Architecture

```text
AI Agent ──X-API-Key──▶ ┌──────────────────────────────┐
Apps     ──X-API-Key──▶ │ gbrain-rag (single Bun image)│ ──▶ docling-serve (optional)
Admin    ──Bearer─────▶ │  unified router · MCP gateway │ ──▶ Postgres + pgvector
                        │  ingest worker · admin proxy │
                        └──────────────────────────────┘
```

The image builds GBrain v0.47.6.0 from source, embeds the anydoc native parser, supervises `gbrain serve --http` (loopback only), and ships migrations for its own tables.

## API surface

| Plane | Auth | Highlights |
|---|---|---|
| Admin | `Authorization: Bearer $ADMIN_TOKEN` | `POST/GET /v1/kb`, `DELETE /v1/kb/:id` (archive), `purge`, `POST/PATCH/DELETE /v1/keys`, `GET /v1/jobs`, `/v1/admin/gbrain/*` |
| Tenant | `X-API-Key: gbrag_...` | `POST /v1/kb/:id/documents` (file/URL/markdown), `GET/DELETE .../documents/...`, `POST /v1/kb/:id/retrieval`, `POST /mcp` |
| Public | — | `/health`, `/docs` (Swagger), `/openapi.json`, `/v1/admin/openapi/gbrain.json` |

Interactive docs: `GET /docs`. Error codes and full contract examples: [docs/usage.md](docs/usage.md) (Chinese).

## Configuration highlights

| Variable | Purpose |
|---|---|
| `ADMIN_TOKEN` / `DATABASE_URL` | required: admin bearer, Postgres URL |
| `DOCLING_URL` | docling endpoint; empty = built-in anydoc (URL/image import rejected with guidance) |
| `PARSER_PREFERENCE` | `docling` (default) or `anydoc` when both parsers are available; the other becomes the failure fallback |
| `EMBEDDING_*` / `RERANK_*` | vendor-neutral model trio (endpoint + model + dims), mapped to engine variables; any OpenAI-compatible gateway works |
| `GBRAIN_CHAT_MODEL` | `provider:model` (e.g. `deepseek:deepseek-v4-flash`) — hybrid expansion / think / autopilot |
| `CORS_ORIGINS` | optional CORS origin list (empty = off, `*` = allow all) |

Full table + model configuration guide: [docs/deployment.md](docs/deployment.md).

## Published images

Multi-arch (`linux/amd64`, `linux/arm64`) images are published by GitHub Actions on pushes to `main` (tags: `main`, `latest`) to:

| Registry | Image |
|---|---|
| GHCR | `ghcr.io/kenny8zeng/gbrain-rag` |
| Docker Hub | `kenny8zeng/gbrain-rag` |

## Documentation

- Guides: [Deployment](docs/deployment.md) · [Usage](docs/usage.md) · [Examples](docs/examples.md) (Chinese)
- API: `GET /docs` · `GET /openapi.json` · specs under [`specs/`](specs/) (001 core, 002 CORS, 003 OpenAPI, 004 anydoc, 005 parser priority)
- Engineering: [docs/testing-strategy.md](docs/testing-strategy.md) (Chinese — defect ledger, test gates, instance matrix)
- Community: [CONTRIBUTING.md](CONTRIBUTING.md) · [CHANGELOG.md](CHANGELOG.md) · [SECURITY.md](SECURITY.md) · [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

## License

[MIT](LICENSE) (Copyright (c) 2026 gbrain-rag contributors)
