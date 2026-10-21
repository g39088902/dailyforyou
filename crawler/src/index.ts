import { config } from "./config.js";
import logger from "./utils/logger.js";
import { openDatabase, closeDatabase } from "./db/client.js";
import { runCrawlerMigrations } from "./db/migrations.js";
import { runCrawlTask } from "./runner.js";

// 防止未捕获异常导致进程无提示退出
process.on("uncaughtException", (err) => {
  logger.error(`[Crawler] Uncaught Exception: ${err?.stack || err}`);
});

process.on("unhandledRejection", (reason) => {
  logger.error(`[Crawler] Unhandled Rejection: ${reason instanceof Error ? reason.stack : reason}`);
});

let shuttingDown = false;
let loopTimer: NodeJS.Timeout | null = null;

const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  if (loopTimer) {
    clearTimeout(loopTimer);
    loopTimer = null;
  }
  logger.info(`🛑 [Crawler] 收到 ${signal}，正在关闭数据库连接并退出...`);
  try {
    await closeDatabase();
  } catch (error) {
    logger.error(`[Crawler] 关闭数据库失败: ${error instanceof Error ? error.message : error}`);
  }
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const main = async () => {
  const args = process.argv.slice(2);
  const isDaemon = args.includes("--daemon") || process.env.DAEMON_MODE === "true";
  const sourceArg = args.find((a) => !a.startsWith("--"));

  const intervalMinutes = Math.max(
    1,
    parseInt(process.env.CRAWL_INTERVAL_MINUTES || "120", 10),
  );

  try {
    await openDatabase();
    await runCrawlerMigrations();

    if (isDaemon) {
      logger.info(
        `🕷️ [Crawler] 启动定时调度模式 (Daemon Mode)，轮询间隔: ${intervalMinutes} 分钟`,
      );
      while (!shuttingDown) {
        try {
          await runCrawlTask({ sourceName: sourceArg });
        } catch (err) {
          logger.error(
            `❌ [Crawler] 本轮抓取出现异常: ${err instanceof Error ? err.message : err}`,
          );
        }

        if (shuttingDown) break;
        logger.info(
          `⏳ [Crawler] 进入休眠，将在 ${intervalMinutes} 分钟后触发下一轮抓取...`,
        );
        await sleep(intervalMinutes * 60 * 1000);
      }
    } else {
      logger.info(`🕷️ [Crawler] 单次抓取模式 (Once Mode)${sourceArg ? `，目标: ${sourceArg}` : ""}`);
      await runCrawlTask({ sourceName: sourceArg });
      await closeDatabase();
      process.exit(0);
    }
  } catch (error) {
    logger.error(
      `❌ [Crawler] 运行异常退出：${error instanceof Error ? error.stack : error}`,
    );
    await closeDatabase().catch(() => {});
    process.exit(1);
  }
};

main();
