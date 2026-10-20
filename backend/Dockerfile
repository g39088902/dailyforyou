FROM node:22-alpine AS base

ENV NODE_ENV=docker

# 清理缓存
RUN rm -rf /var/cache/apk/*

# 构建阶段
FROM base AS builder

RUN npm install -g pnpm
WORKDIR /app

COPY package*json tsconfig.json pnpm-lock.yaml .env.example ./
COPY src ./src

# 复制环境变量
RUN [ ! -e ".env" ] && cp .env.example .env || true

# 安装依赖
RUN pnpm install
RUN pnpm build
RUN pnpm prune --production

# 运行阶段
FROM base AS runner

# 创建用户和组
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 hono

# 创建日志与数据目录
RUN mkdir -p /app/logs /app/data && chown -R hono:nodejs /app/logs /app/data
RUN ln -s /app/logs /logs

# 复制文件
COPY --from=builder --chown=hono:nodejs /app/node_modules /app/node_modules
COPY --from=builder --chown=hono:nodejs /app/dist /app/dist
COPY --from=builder /app/.env /app/.env
COPY --from=builder /app/package.json /app/package.json

# 切换用户
USER hono

# 暴露端口（用户服务）
EXPOSE 6690

# 运行
CMD ["node", "/app/dist/index.js"]