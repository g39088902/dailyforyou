/**
 * PM2 配置：爬虫定时调度器（无 HTTP 端口，出站抓取并写入远程 libSQL/SQLite 数据库）
 * 直接以 node 运行编译产物，不依赖 npm、cross-env 等 devDependencies。
 */
module.exports = {
  apps: [
    {
      name: 'dailyhot-crawler',
      script: 'dist/index.js',
      args: '--daemon',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        DAEMON_MODE: 'true',
        CRAWL_INTERVAL_MINUTES: '120',
      },
      out_file: './logs/pm2-out.log',
      error_file: './logs/pm2-error.log',
      merge_logs: true,
      time: true,
    },
  ],
};
