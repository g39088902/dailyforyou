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
  # 防呆：tsconfig 的 rootDir/include 一旦被改动，产物会变成 dist/src/index.js，
  # 而 PM2 指向 dist/index.js —— 此时部署看似成功、实际仍在跑旧代码。
  [ -f "$ROOT/backend/dist/index.js" ] || fail "构建产物缺少 dist/index.js（检查 tsconfig 的 rootDir/include）"

  info "上传编译产物"
  # dist 单独用 --delete 同步，清掉历史遗留的旧结构（如 dist/src）避免误判线上代码。
  rsync -az --timeout=60 --delete "$ROOT/backend/dist/" "$REMOTE:$REMOTE_DIR/back/dist/" \
    || fail "上传 dist 失败"
  rsync -az --timeout=60 "$ROOT/backend/package.json" \
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

# 等待某个路径返回预期状态码（PM2 重启后端口需要几百毫秒才就绪，避免误判 502）
expect_code() {
  local path="$1" expect="$2" label="$3" tries=15 code=""
  for _ in $(seq 1 "$tries"); do
    code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$SITE$path")
    if [ "$code" = "$expect" ]; then
      return 0
    fi
    sleep 1
  done
  fail "${label} 返回 ${code}（应为 ${expect}）"
}

health_check() {
  info "健康检查"
  expect_code "/api/auth/providers" "200" "/api/auth/providers"
  expect_code "/api/score" "401" "/api/score（鉴权未生效）"
  expect_code "/api/sources" "200" "/api/sources（动态信源清单）"
  expect_code "/api/logo/reuters-world.png" "200" "/api/logo/reuters-world.png（动态图标）"
  expect_code "/api/health" "200" "/api/health（综合健康探针）"

  # 确认爬虫状态正常
  local health_resp
  health_resp=$(curl -s -m 10 "$SITE/api/health")
  info "服务器健康状态: $health_resp"

  ok "站点 $SITE 正常（/api/sources, /api/logo, /api/health, /api/auth 均就绪）"
}

case "$TARGET" in
  backend)  deploy_backend; health_check ;;
  crawler)  deploy_crawler; health_check ;;
  frontend) deploy_frontend; health_check ;;
  all)      deploy_backend; deploy_crawler; deploy_frontend; health_check ;;
  *) echo "用法: $0 [backend|crawler|frontend|all]"; exit 1 ;;
esac
