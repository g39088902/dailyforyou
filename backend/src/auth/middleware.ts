import type { MiddlewareHandler } from "hono";
import type { AuthUser } from "../types.js";
import { verifyAuthToken } from "./jwt.js";

export type AuthEnv = { Variables: { authUser: AuthUser } };

const unauthorized = (message: string, c: any) =>
  c.json({ code: 401, message, needLogin: true }, 401);

/**
 * 接口鉴权中间件
 * 注意：
 * 1. 必须用 c.json 返回，不能 throw —— app.onError 会渲染 HTML 错误页，破坏 API 契约
 * 2. 首行做幂等保护：/score 与 /score/* 可能同时命中，避免重复校验
 */
export const requireAuth: MiddlewareHandler<AuthEnv> = async (c, next) => {
  if (c.get("authUser")) return next();

  const raw = (c.req.header("Authorization") || "").trim();
  const matched = /^Bearer\s+(.+)$/i.exec(raw);
  if (!matched) {
    return unauthorized("请先登录后使用该功能", c);
  }

  try {
    const user = await verifyAuthToken(matched[1].trim());
    c.set("authUser", user);
  } catch {
    return unauthorized("登录状态已失效，请重新登录", c);
  }

  return next();
};
