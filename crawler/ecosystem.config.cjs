/**
 * PM2 配置：爬虫服务（抓取 / 翻译 / 入库）
 * 直接以 node 运行编译产物，不依赖 npm、cross-env 等 devDependencies。
 */
module.exports = {
  apps: [
    {
      name: 'dailyhot-crawler',
      script: 'dist/index.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      // 仅监听回环地址，外部一律经 Nginx 反代
      env: {
        NODE_ENV: 'development',
        PORT: 6688,
        HOST: '127.0.0.1',
      },
      out_file: './logs/pm2-out.log',
      error_file: './logs/pm2-error.log',
      merge_logs: true,
      time: true,
    },
  ],
};
