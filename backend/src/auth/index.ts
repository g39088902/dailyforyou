import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { getAddress, isAddress, verifyMessage } from "viem";
import { config } from "../config.js";
import logger from "../utils/logger.js";
import { consumeRateLimit } from "../utils/rateLimit.js";
import {
  bindDefaultUserIdentity,
  consumeAuthNonce,
  countRecentNonces,
  createAuthNonce,
  findOrCreateUserByWallet,
  getAuthNonce,
  getUserById,
  listIdentitiesByUser,
  purgeExpiredNonces,
  recordNonceFailure,
} from "../utils/authDb.js";
import { getPromptRecord } from "../utils/promptDb.js";
import { buildSiweMessage, extractAddress, extractNonce, resolveAuthDomain, resolveAuthUri } from "./message.js";
import { signAuthToken } from "./jwt.js";
import { requireAuth, type AuthEnv } from "./middleware.js";
import { assertProviderEnabled, listAuthProviders } from "./providers.js";
import type { AuthProviderId } from "../types.js";

export const authRouter = new Hono<AuthEnv>();

const getClientIp = (c: any): string => {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return c.req.header("x-real-ip") || "unknown";
};

const readJsonBody = async (c: any): Promise<any | null> => {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
};

const buildUserPayload = (
  user: { id: number; display_name: string },
  address: string,
  prompt: { promptHash: string; updatedAt: string },
) => ({
  id: user.id,
  displayName: user.display_name,
  address: getAddress(address),
  provider: "ethereum" as const,
  isDefaultAccount: user.id === config.DEFAULT_USER_ID,
  promptHash: prompt.promptHash,
  promptUpdatedAt: prompt.updatedAt,
});

/**
 * 可用的登录渠道（前端据此渲染灰态入口）
 */
authRouter.get("/providers", (c) =>
  c.json({ code: 200, data: listAuthProviders() }),
);

/**
 * 申请一次性签名挑战
 */
authRouter.post("/nonce", async (c) => {
  try {
    const body = await readJsonBody(c);
    const rawAddress = typeof body?.address === "string" ? body.address.trim() : "";
    if (!isAddress(rawAddress)) {
      return c.json({ code: 400, message: "无效的钱包地址" }, 400);
    }

    const address = rawAddress.toLowerCase();
    const chainId = Number(body?.chainId) > 0 ? Number(body.chainId) : 1;
    const ip = getClientIp(c);

    const ipLimit = consumeRateLimit(`auth:nonce:ip:${ip}`, config.AUTH_RATE_LIMIT_PER_MIN * 3);
    const addrLimit = consumeRateLimit(`auth:nonce:addr:${address}`, config.AUTH_RATE_LIMIT_PER_MIN);
    if (!ipLimit.allowed || !addrLimit.allowed) {
      return c.json(
        { code: 429, message: "请求过于频繁，请稍后再试", retryAfter: Math.max(ipLimit.retryAfterSeconds, addrLimit.retryAfterSeconds) },
        429,
      );
    }

    const recent = await countRecentNonces(address, 60);
    if (recent >= config.AUTH_RATE_LIMIT_PER_MIN) {
      return c.json({ code: 429, message: "请求过于频繁，请稍后再试" }, 429);
    }

    await purgeExpiredNonces();

    const nonce = randomBytes(16).toString("hex");
    const issuedAtDate = new Date();
    const expiresAtDate = new Date(issuedAtDate.getTime() + config.AUTH_NONCE_TTL * 1000);
    const issuedAt = issuedAtDate.toISOString();
    const expiresAt = expiresAtDate.toISOString();

    const domain = resolveAuthDomain();
    const message = buildSiweMessage({
      domain,
      address: getAddress(address),
      uri: resolveAuthUri(),
      chainId,
      nonce,
      issuedAt,
      expiresAt,
    });

    await createAuthNonce({ nonce, address, message, issuedAt, expiresAt });

    return c.json({
      code: 200,
      nonce,
      message,
      domain,
      chainId,
      issuedAt,
      expiresAt,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    logger.error(`❌ [Auth] nonce failed: ${msg}`);
    return c.json({ code: 500, message: `获取登录挑战失败: ${msg}` }, 500);
  }
});

/**
 * 校验钱包签名并签发 JWT
 */
authRouter.post("/verify", async (c) => {
  try {
    const body = await readJsonBody(c);
    const message = typeof body?.message === "string" ? body.message : "";
    const signature = typeof body?.signature === "string" ? body.signature.trim() : "";

    if (!message || !signature) {
      return c.json({ code: 400, message: "缺少 message 或 signature" }, 400);
    }

    const nonce = extractNonce(message);
    if (!nonce) {
      return c.json({ code: 400, message: "签名消息中缺少 nonce" }, 400);
    }

    const record = await getAuthNonce(nonce);
    if (!record) {
      return c.json({ code: 401, message: "登录挑战不存在，请重新获取" }, 401);
    }
    if (record.consumed_at) {
      return c.json({ code: 401, message: "登录挑战已使用，请重新获取" }, 401);
    }
    if (record.expires_at <= new Date().toISOString()) {
      return c.json({ code: 401, message: "登录挑战已过期，请重新获取" }, 401);
    }
    if (record.message !== message) {
      await recordNonceFailure(nonce);
      return c.json({ code: 401, message: "签名消息与挑战不匹配" }, 401);
    }

    const messageAddress = extractAddress(message);
    if (!messageAddress || messageAddress !== record.address) {
      await recordNonceFailure(nonce);
      return c.json({ code: 401, message: "签名地址与挑战不匹配" }, 401);
    }

    if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
      await recordNonceFailure(nonce);
      return c.json({ code: 401, message: "签名格式非法" }, 401);
    }

    let valid = false;
    try {
      valid = await verifyMessage({
        address: getAddress(record.address),
        message,
        signature: signature as `0x${string}`,
      });
    } catch (error) {
      valid = false;
      logger.warn(
        `⚠️ [Auth] verifyMessage error: ${error instanceof Error ? error.message : "unknown"}`,
      );
    }

    if (!valid) {
      const attempts = await recordNonceFailure(nonce);
      logger.warn(`⚠️ [Auth] 签名验证失败 address=${record.address} attempts=${attempts}`);
      return c.json({ code: 401, message: "签名验证失败" }, 401);
    }

    const consumed = await consumeAuthNonce(nonce);
    if (!consumed) {
      return c.json({ code: 401, message: "登录挑战已使用，请重新获取" }, 401);
    }

    const { user, isNew, claimedDefault } = await findOrCreateUserByWallet(record.address, {
      chainId: body?.chainId ?? 0,
      userAgent: c.req.header("user-agent") || "",
    });

    const prompt = await getPromptRecord(user.id);
    const token = await signAuthToken(user);

    logger.info(
      `🔐 [Auth] login ok user_id=${user.id} address=${record.address} new=${isNew} claimedDefault=${claimedDefault}`,
    );

    return c.json({
      code: 200,
      token,
      tokenType: "Bearer",
      expiresIn: config.AUTH_JWT_TTL,
      isNewUser: isNew,
      claimedDefault,
      user: buildUserPayload(user, record.address, prompt),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    logger.error(`❌ [Auth] verify failed: ${msg}`);
    return c.json({ code: 500, message: `登录失败: ${msg}` }, 500);
  }
});

/**
 * 当前登录用户信息
 */
authRouter.get("/me", requireAuth, async (c) => {
  try {
    const { userId } = c.get("authUser");
    const user = await getUserById(userId);
    if (!user) {
      return c.json({ code: 401, message: "用户不存在，请重新登录", needLogin: true }, 401);
    }

    const identities = await listIdentitiesByUser(userId);
    const ethereumIdentity = identities.find((item) => item.provider === "ethereum");
    const prompt = await getPromptRecord(userId);

    return c.json({
      code: 200,
      data: {
        user: ethereumIdentity
          ? buildUserPayload(user, ethereumIdentity.provider_user_id, prompt)
          : {
              id: user.id,
              displayName: user.display_name,
              address: null,
              provider: null,
              isDefaultAccount: user.id === config.DEFAULT_USER_ID,
              promptHash: prompt.promptHash,
              promptUpdatedAt: prompt.updatedAt,
            },
        identities: identities.map((item) => ({
          provider: item.provider,
          providerUserId: item.provider_user_id,
          createdAt: item.created_at,
          lastLoginAt: item.last_login_at,
        })),
        profile: {
          promptHash: prompt.promptHash,
          promptUpdatedAt: prompt.updatedAt,
          promptLength: prompt.prompt.length,
        },
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    logger.error(`❌ [Auth] me failed: ${msg}`);
    return c.json({ code: 500, message: `获取用户信息失败: ${msg}` }, 500);
  }
});

/**
 * 退出登录（JWT 无状态，客户端丢弃令牌即可；保留接口便于将来做黑名单）
 */
authRouter.post("/logout", (c) => c.json({ code: 200, message: "已退出登录" }));

/**
 * 预留渠道：微信扫码（尚未实现）
 */
authRouter.post("/wechat/challenge", (c) => {
  try {
    assertProviderEnabled("wechat" as AuthProviderId);
    return c.json({ code: 500, message: "unreachable" }, 500);
  } catch {
    return c.json(
      {
        code: 501,
        message: "provider_not_implemented",
        provider: "wechat",
        hint: "计划支持：微信开放平台扫码登录",
      },
      501,
    );
  }
});

/**
 * 预留渠道：手机号（尚未实现）
 */
authRouter.post("/phone/verify", (c) => {
  try {
    assertProviderEnabled("phone" as AuthProviderId);
    return c.json({ code: 500, message: "unreachable" }, 500);
  } catch {
    return c.json(
      {
        code: 501,
        message: "provider_not_implemented",
        provider: "phone",
        hint: "计划支持：短信验证码登录",
      },
      501,
    );
  }
});

/**
 * 启动时调用：把 DEFAULT_USER_ADDRESS 绑定到默认账户
 */
export const initDefaultUserBinding = async (): Promise<void> => {
  await bindDefaultUserIdentity();
};

export default authRouter;
