/**
 * PM2 配置：用户服务（登录 / 评分 / Prompt）
 * 直接以 node 运行编译产物，不依赖 npm、cross-env 等 devDependencies，
 * 因此生产环境可用 `pnpm install --prod` 只装运行期依赖。
 */
module.exports = {
  apps: [
    {
      name: 'dailyhot-back',
      script: 'dist/index.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      // 仅监听回环地址，外部一律经 Nginx 反代
      env: {
        NODE_ENV: 'development',
        PORT: 6690,
        HOST: '127.0.0.1',
      },
      out_file: './logs/pm2-out.log',
      error_file: './logs/pm2-error.log',
      merge_logs: true,
      time: true,
    },
  ],
};
