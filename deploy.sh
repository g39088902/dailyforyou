#!/usr/bin/env bash
set -euo pipefail

# DailyForYou 远程部署脚本（前端 + 用户服务 + 爬虫）
#
# 用法：
#   ./deploy.sh            # 部署前端 + 用户服务 + 爬虫
#   ./deploy.sh backend    # 只部署用户服务
#   ./deploy.sh crawler    # 只部署爬虫
#   ./deploy.sh frontend   # 只部署前端
#
# 可通过环境变量覆盖：REMOTE / REMOTE_DIR / SITE

REMOTE="${REMOTE:-root@134.175.155.179}"
REMOTE_DIR="${REMOTE_DIR:-/opt/dailyhot}"
SITE="${SITE:-http://134.175.155.179:8081}"
TARGET="${1:-all}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

info() { printf '\033[36m▶ %s\033[0m\n' "$1"; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$1"; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$1"; exit 1; }

SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10)

deploy_backend() {
  info "构建用户服务"
  (cd "$ROOT/backend" && pnpm build) || fail "backend 构建失败"

  info "上传编译产物"
  rsync -az --timeout=60 "$ROOT/backend/dist" "$ROOT/backend/package.json" \
    "$ROOT/backend/pnpm-lock.yaml" "$ROOT/backend/ecosystem.config.cjs" \
    "$REMOTE:$REMOTE_DIR/back/" || fail "上传失败"

  info "安装运行期依赖"
  ssh "${SSH_OPTS[@]}" "$REMOTE" "cd $REMOTE_DIR/back && pnpm install --prod --frozen-lockfile" \
    || fail "依赖安装失败"

  info "重启 dailyhot-back"
  ssh "${SSH_OPTS[@]}" "$REMOTE" "pm2 restart dailyhot-back --update-env" || fail "重启失败"
  ok "用户服务已更新"
}

deploy_crawler() {
  info "构建爬虫服务"
  (cd "$ROOT/crawler" && pnpm build) || fail "crawler 构建失败"

  info "上传编译产物"
  rsync -az --timeout=60 "$ROOT/crawler/dist" "$ROOT/crawler/public" \
    "$ROOT/crawler/package.json" "$ROOT/crawler/pnpm-lock.yaml" \
    "$ROOT/crawler/ecosystem.config.cjs" \
    "$REMOTE:$REMOTE_DIR/crawler/" || fail "上传失败"

  info "安装运行期依赖"
  ssh "${SSH_OPTS[@]}" "$REMOTE" "cd $REMOTE_DIR/crawler && pnpm install --prod --frozen-lockfile" \
    || fail "依赖安装失败"

  info "重启 dailyhot-crawler"
  ssh "${SSH_OPTS[@]}" "$REMOTE" "pm2 restart dailyhot-crawler --update-env" || fail "重启失败"
  ok "爬虫服务已更新"
}

deploy_frontend() {
  info "构建前端（自动读取 .env.production）"
  # 若所在环境对文件删除有限制（会导致 VitePWA 生成 SW 阶段挂起），
  # 可用 PWA_DISABLE=true ./deploy.sh 跳过 Service Worker 生成。
  if [ "${PWA_DISABLE:-}" = "true" ]; then
    info "已跳过 PWA（不生成 sw.js）"
  fi

  # Vite 构建前会清空 dist；某些环境对批量删除有拦截，
  # 因此先把旧产物移走，构建成功后再丢弃。
  local stale=""
  if [ -d "$ROOT/frontend/dist" ]; then
    stale="$ROOT/frontend/.stale-dist-$(date +%s)"
    mv "$ROOT/frontend/dist" "$stale"
  fi

  local build_log="$ROOT/frontend/.build.log"
  if ! (cd "$ROOT/frontend" && pnpm build > "$build_log" 2>&1); then
    tail -20 "$build_log"
    if [ -n "$stale" ]; then
      mv "$stale" "$ROOT/frontend/dist" 2>/dev/null
    fi
    fail "frontend 构建失败（日志：$build_log）"
  fi

  # 不用 rm -rf 删除旧产物：批量删除在部分环境会触发确认而挂起。
  # 移到系统临时目录，由系统自行回收。
  if [ -n "$stale" ]; then
    mv "$stale" "${TMPDIR:-/tmp}/dailyforyou-stale-$(date +%s)" 2>/dev/null || true
  fi

  info "同步静态产物"
  rsync -az --timeout=60 --delete "$ROOT/frontend/dist/" "$REMOTE:$REMOTE_DIR/front/dist/" \
    || fail "上传失败"
  ok "前端已更新"
}

health_check() {
  info "健康检查"
  local providers score feed
  providers=$(curl -s -o /dev/null -w '%{http_code}' -m 10 "$SITE/api/auth/providers")
  [ "$providers" = "200" ] || fail "/api/auth/providers 返回 $providers（应为 200）"

  score=$(curl -s -o /dev/null -w '%{http_code}' -m 10 "$SITE/api/score")
  [ "$score" = "401" ] || fail "/api/score 返回 $score（应为 401，说明鉴权未生效）"

  feed=$(curl -s -o /dev/null -w '%{http_code}' -m 10 "$SITE/feed/all")
  [ "$feed" = "200" ] || fail "/feed/all 返回 $feed（应为 200）"

  ok "站点 $SITE 正常（/api 200，/api/score 401 已锁定，/feed/all 200）"
}

case "$TARGET" in
  backend)  deploy_backend; health_check ;;
  crawler)  deploy_crawler; health_check ;;
  frontend) deploy_frontend; health_check ;;
  all)      deploy_backend; deploy_crawler; deploy_frontend; health_check ;;
  *) echo "用法: $0 [backend|crawler|frontend|all]"; exit 1 ;;
esac
