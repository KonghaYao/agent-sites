# 多阶段 build：
#   pb-fetcher: alpine 拉 + 解压 Linux 版 PocketBase（按 TARGETARCH 自动选 amd64/arm64）
#   final:      denoland/deno:2.7.14 + 预 cache + COPY src + COPY public + 嵌入 PB

ARG PB_VERSION=0.23.10
ARG DENO_VERSION=2.7.14

# ----- Stage 1: 拉 PocketBase Linux 二进制 -----
FROM alpine:3.19 AS pb-fetcher
ARG PB_VERSION
ARG TARGETARCH=amd64
RUN apk add --no-cache unzip \
  && wget -O /tmp/pb.zip \
       "https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/pocketbase_${PB_VERSION}_linux_${TARGETARCH}.zip" \
  && unzip /tmp/pb.zip pocketbase -d /out \
  && chmod +x /out/pocketbase \
  && /out/pocketbase --version

# ----- Stage 2: 最终镜像 -----
FROM denoland/deno:${DENO_VERSION}
WORKDIR /app

# 先 COPY 依赖描述 + cache，最大化利用 layer cache
COPY deno.json deno.lock ./
COPY src ./src
RUN deno cache src/main.ts

# Pre-cache PocketBase JS SDK 用于 custom app（避免首次 deploy 冷启动 >10s 探活超时）。
# 不 pin 版本——Deno 运行时会用缓存中的最新解析结果；custom app 代码 import 也无需带版本号。
RUN deno cache jsr:@pocketbase/pocketbase

# COPY 前端静态文件：
#   - public/       → 运行时目录（用户上传的前端文件 + 控制面板）
#   - _panel-seed/  → 镜像内置 seed，供 entrypoint 在 bind mount 覆盖后恢复 _panel
COPY public/_panel /app/_panel-seed
COPY public ./public

# 嵌入 PocketBase 二进制（来自 Stage 1）
COPY --from=pb-fetcher /out/pocketbase /app/bin/pocketbase

# entrypoint：确保 _panel 存在（应对 bind mount /app/public 覆盖）
COPY scripts/docker-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# 显式声明运行时配置
ENV PB_BINARY=bin/pocketbase \
    DATA_DIR=data \
    PUBLIC_DIR=public

EXPOSE 3000
# 仅声明 data 为匿名 volume；public 由镜像自带 + entrypoint seed 兜底
VOLUME ["/app/data"]

# AGENT_SITES_MASTER_KEY 必须由运行时（env_file 或 -e）注入
ENTRYPOINT ["/entrypoint.sh"]
CMD ["run", "--allow-all", "src/main.ts"]
