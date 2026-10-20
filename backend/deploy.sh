#!/bin/bash

# 日志文件
LOG_FILE="deploy.log"

# 输出时间戳的日志函数
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a $LOG_FILE
}

# 错误处理函数
handle_error() {
    log "错误: $1"
    exit 1
}

# 部署单个服务：安装依赖 → 构建 → 重启 PM2
deploy_service() {
    local dir="$1"
    local app="$2"

    log "开始部署 ${dir} (${app})..."
    (cd "$dir" && npm install) || handle_error "${dir} 依赖安装失败"
    (cd "$dir" && npm run build) || handle_error "${dir} 构建失败"

    pm2 restart "$app" || (cd "$dir" && pm2 start ecosystem.config.cjs) || handle_error "${app} 启动失败"
}

# 拉取代码（仓库根目录）
log "开始拉取代码..."
git -C .. pull || handle_error "git pull 失败"

# 两个后端服务独立部署，任一失败不影响已有进程
deploy_service "$(pwd)" "dailyhot-back"
deploy_service "../crawler" "dailyhot-crawler"

log "部署完成!"
