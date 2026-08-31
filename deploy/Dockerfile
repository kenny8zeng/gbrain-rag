# ---- stage 1: gbrain 源码编译（research D1：核心包必须源码构建） ----
FROM oven/bun:1 AS gbrain-builder
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git clone --depth 1 --branch v0.47.6.0 https://github.com/garrytan/gbrain.git .
RUN bun install
# 产物为 bun compile 自包含 ELF；若 serve 需要额外资产步骤，在此追加（冒烟判定见 tasks T006）
RUN bun run build

# ---- stage 2: 应用依赖安装 ----
FROM oven/bun:1 AS app-deps
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/server/package.json apps/server/
COPY packages/core/package.json packages/core/
RUN bun install --frozen-lockfile

# ---- stage 3: 运行层 ----
FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -u 1000 rag \
    && mkdir -p /data/rag && chown rag:rag /data/rag
COPY --from=gbrain-builder /src/bin/gbrain /usr/local/bin/gbrain
COPY --from=oven/bun:1 /usr/local/bin/bun /usr/local/bin/bun
COPY --from=app-deps --chown=rag /app /app
COPY --chown=rag tsconfig.json /app/
COPY --chown=rag apps/ /app/apps/
COPY --chown=rag packages/ /app/packages/
COPY --chown=rag deploy/entrypoint.sh /app/deploy/entrypoint.sh
COPY --chown=rag deploy/migrations/ /app/deploy/migrations/
COPY --chown=rag deploy/clis/ /app/deploy/clis/
WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data/rag \
    GBRAIN_BIN=/usr/local/bin/gbrain
VOLUME ["/data/rag"]
USER rag
EXPOSE 3000
ENTRYPOINT ["bash", "deploy/entrypoint.sh"]
