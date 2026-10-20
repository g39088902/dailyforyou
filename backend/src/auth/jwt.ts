import crypto from "node:crypto";
import { sign, verify } from "hono/jwt";
import { config } from "../config.js";
import logger from "../utils/logger.js";
import type { AuthUser } from "../types.js";

let resolvedSecret: string | null = null;

/**
 * 获取 JWT 密钥：生产环境必须显式配置，development 允许随机密钥（重启即全员掉线）
 */
export const getJwtSecret = (): string => {
  if (resolvedSecret) return resolvedSecret;

  if (config.AUTH_JWT_SECRET) {
    resolvedSecret = config.AUTH_JWT_SECRET;
    return resolvedSecret;
  }

  if (process.env.NODE_ENV !== "development") {
    throw new Error(
      "AUTH_JWT_SECRET 未配置：生产环境必须显式设置（可用 openssl rand -hex 32 生成）",
    );
  }

  resolvedSecret = crypto.randomBytes(32).toString("hex");
  logger.warn(
    "⚠️ [Auth] 未配置 AUTH_JWT_SECRET，已生成进程内随机密钥。重启后所有登录态失效。",
  );
  return resolvedSecret;
};

/**
 * 签发登录令牌
 */
export const signAuthToken = async (user: {
  id: number;
  token_version: number;
}): Promise<string> => {
  const now = Math.floor(Date.now() / 1000);
  return sign(
    {
      sub: String(user.id),
      ver: user.token_version,
      iss: "dailyforyou",
      iat: now,
      exp: now + config.AUTH_JWT_TTL,
    },
    getJwtSecret(),
    "HS256",
  );
};

/**
 * 校验登录令牌，返回请求上下文用户
 */
export const verifyAuthToken = async (token: string): Promise<AuthUser> => {
  const payload = await verify(token, getJwtSecret(), "HS256");
  const userId = Number(payload?.sub);
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error("令牌载荷非法");
  }
  return { userId, provider: "ethereum" };
};
