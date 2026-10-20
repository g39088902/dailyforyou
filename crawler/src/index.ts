import { serve } from "@hono/node-server";
import { config } from "./config.js";
import logger from "./utils/logger.js";
import { openDatabase, closeDatabase } from "./db/client.js";
import { runCrawlerMigrations } from "./db/migrations.js";
import app from "./app.js";

// 防止异步抓取/网络请求意外异常导致服务崩溃退出
process.on("uncaughtException", (err) => {
  logger.error(`[Crawler] Uncaught Exception: ${err?.stack || err}`);
});

process.on("unhandledRejection", (reason) => {
  logger.error(`[Crawler] Unhandled Rejection: ${reason instanceof Error ? reason.stack : reason}`);
});

let shuttingDown = false;

const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`🛑 [Crawler] 收到 ${signal}，正在关闭数据库连接...`);
  try {
    await closeDatabase();
  } catch (error) {
    logger.error(`[Crawler] 关闭数据库失败: ${error instanceof Error ? error.message : error}`);
  }
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

const startCrawler = async (port: number = config.PORT) => {
  try {
    await openDatabase();
    await runCrawlerMigrations();

    const apiServer = serve({
      fetch: app.fetch,
      port,
      hostname: config.HOST,
    });
    logger.info(`🕷️ DailyForYou Crawler 已启动，端口 ${port}`);
    logger.info(`🔗 Local: 👉 http://localhost:${port}`);
    return apiServer;
  } catch (error) {
    logger.error(
      `❌ [Crawler] 启动失败，进程退出：${error instanceof Error ? error.stack : error}`,
    );
    process.exit(1);
  }
};

if (process.env.NODE_ENV === "development" || process.env.NODE_ENV === "docker") {
  startCrawler(config.PORT);
}

export default startCrawler;
