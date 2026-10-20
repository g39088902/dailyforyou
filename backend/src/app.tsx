import { Hono } from "hono";
import { cors } from "hono/cors";
import { config } from "./config.js";
import { compress } from "hono/compress";
import { prettyJSON } from "hono/pretty-json";
import { trimTrailingSlash } from "hono/trailing-slash";
import logger from "./utils/logger.js";
import registry from "./registry.js";

const app = new Hono();

// CORS（置于最前，确保 OPTIONS 预检与所有响应均携带合法跨域头）
app.use(
  "*",
  cors({
    origin: (origin) => {
      if (!origin) return "*";
      const isSame = config.ALLOWED_HOST && origin.endsWith(config.ALLOWED_HOST);
      if (isSame) return origin;
      return config.ALLOWED_DOMAIN === "*" ? origin : config.ALLOWED_DOMAIN;
    },
    allowMethods: ["POST", "GET", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "X-Custom-Header", "Upgrade-Insecure-Requests"],
    credentials: true,
  }),
);

// 压缩响应
app.use(compress());

// prettyJSON
app.use(prettyJSON());

// 尾部斜杠重定向
app.use(trimTrailingSlash());

// 主路由（鉴权 / 账户 / 评分）
app.route("/", registry);

// 用户服务是纯 JSON API：404 与异常也返回 JSON，避免前端拿到 HTML 错误页
app.notFound((c) => c.json({ code: 404, message: "Not Found" }, 404));
app.onError((err, c) => {
  logger.error(`❌ [ERROR] ${err?.message}`);
  return c.json({ code: 500, message: "Internal Server Error" }, 500);
});

export default app;
