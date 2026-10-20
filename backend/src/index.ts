import { serve } from "@hono/node-server";
import { config } from "./config.js";
import logger from "./utils/logger.js";
import { initScoreDb, closeScoreDb } from "./utils/scoreDb.js";
import { initDefaultUserBinding } from "./auth/index.js";
import app from "./app.js";

// 防止异步打分/网络请求意外异常导致服务崩溃退出
process.on("uncaughtException", (err) => {
  logger.error(`[Process] Uncaught Exception: ${err?.stack || err}`);
});

process.on("unhandledRejection", (reason) => {
  logger.error(`[Process] Unhandled Rejection: ${reason instanceof Error ? reason.stack : reason}`);
});

let shuttingDown = false;

const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`🛑 [Process] 收到 ${signal}，正在关闭数据库连接...`);
  try {
    await closeScoreDb();
  } catch (error) {
    logger.error(`[Process] 关闭数据库失败: ${error instanceof Error ? error.message : error}`);
  }
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

// 启动服务器
const serveHotApi = async (port: number = config.PORT) => {
  try {
    // 数据库迁移失败必须直接退出，避免带着半成品表结构对外服务
    await initScoreDb();
    await initDefaultUserBinding();

    const apiServer = serve({
      fetch: app.fetch,
      port,
      hostname: config.HOST,
    });
    logger.info(`🔥 DailyHot API successfully runs on port ${port}`);
    logger.info(`🔗 Local: 👉 http://localhost:${port}`);
    return apiServer;
  } catch (error) {
    logger.error(
      `❌ [Startup] 初始化失败，进程退出：${error instanceof Error ? error.stack : error}`,
    );
    process.exit(1);
  }
};

if (process.env.NODE_ENV === "development" || process.env.NODE_ENV === "docker") {
  serveHotApi(config.PORT);
}

export default serveHotApi;
