import { Hono } from "hono";
import { config } from "../config.js";
import logger from "../utils/logger.js";
import { consumeRateLimit } from "../utils/rateLimit.js";
import { getUserById, listIdentitiesByUser } from "../utils/authDb.js";
import {
  getPromptContext,
  getPromptRecord,
  resetUserPrompt,
  updateUserPrompt,
  validatePrompt,
} from "../utils/promptDb.js";
import { extractNewsMetadata, requestScoreCompletion } from "../utils/scorer.js";
import { hashPrompt } from "../utils/scorePrompt.js";
import { requireAuth, type AuthEnv } from "../auth/middleware.js";

export const accountRouter = new Hono<AuthEnv>();

const readJsonBody = async (c: any): Promise<any | null> => {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
};

const DEFAULT_SAMPLE = {
  source: "DeepSeek",
  title: "DeepSeek V4.1 Flash 正式发布，推理吞吐提升 40%",
  desc: "官方表示新版本在长上下文与工具调用场景下延迟显著下降，并同步开放 API。",
};

/**
 * 账户概览
 */
accountRouter.get("/profile", requireAuth, async (c) => {
  try {
    const { userId } = c.get("authUser");
    const [user, identities, prompt] = await Promise.all([
      getUserById(userId),
      listIdentitiesByUser(userId),
      getPromptRecord(userId),
    ]);

    if (!user) {
      return c.json({ code: 401, message: "用户不存在，请重新登录", needLogin: true }, 401);
    }

    return c.json({
      code: 200,
      data: {
        id: user.id,
        displayName: user.display_name,
        createdAt: user.created_at,
        isDefaultAccount: user.id === config.DEFAULT_USER_ID,
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
    logger.error(`❌ [Account] profile failed: ${msg}`);
    return c.json({ code: 500, message: `获取账户信息失败: ${msg}` }, 500);
  }
});

/**
 * 读取当前 Prompt
 */
accountRouter.get("/prompt", requireAuth, async (c) => {
  try {
    const { userId } = c.get("authUser");
    const context = await getPromptContext(userId);
    const record = await getPromptRecord(userId);

    return c.json({
      code: 200,
      data: {
        prompt: context.prompt,
        promptHash: context.promptHash,
        isDefault: context.isDefault,
        maxLength: config.SCORE_PROMPT_MAX_LENGTH,
        updatedAt: record.updatedAt,
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    logger.error(`❌ [Account] get prompt failed: ${msg}`);
    return c.json({ code: 500, message: `读取 Prompt 失败: ${msg}` }, 500);
  }
});

/**
 * 保存自定义 Prompt（允许完全自定义规则与输出格式）
 */
accountRouter.put("/prompt", requireAuth, async (c) => {
  try {
    const { userId } = c.get("authUser");
    const body = await readJsonBody(c);
    const validation = validatePrompt(body?.prompt);
    if (validation.ok === false) {
      return c.json({ code: 400, message: validation.message }, 400);
    }

    const prompt = String(body.prompt);
    const context = await updateUserPrompt(userId, prompt);
    const record = await getPromptRecord(userId);

    logger.info(
      `📝 [Account] user=${userId} 更新 Prompt，hash=${context.promptHash.slice(0, 8)} len=${prompt.length}`,
    );

    return c.json({
      code: 200,
      data: {
        prompt: context.prompt,
        promptHash: context.promptHash,
        isDefault: context.isDefault,
        updatedAt: record.updatedAt,
      },
      warnings: validation.warnings,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    logger.error(`❌ [Account] update prompt failed: ${msg}`);
    return c.json({ code: 500, message: `保存 Prompt 失败: ${msg}` }, 500);
  }
});

/**
 * 重置为系统默认 Prompt
 */
accountRouter.post("/prompt/reset", requireAuth, async (c) => {
  try {
    const { userId } = c.get("authUser");
    const context = await resetUserPrompt(userId);
    const record = await getPromptRecord(userId);

    return c.json({
      code: 200,
      data: {
        prompt: context.prompt,
        promptHash: context.promptHash,
        isDefault: true,
        updatedAt: record.updatedAt,
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    logger.error(`❌ [Account] reset prompt failed: ${msg}`);
    return c.json({ code: 500, message: `重置 Prompt 失败: ${msg}` }, 500);
  }
});

/**
 * 试跑 Prompt：不写库、不影响该用户已有评分
 */
accountRouter.post("/prompt/test", requireAuth, async (c) => {
  try {
    const { userId } = c.get("authUser");

    const limit = consumeRateLimit(
      `account:prompt-test:${userId}`,
      config.PROMPT_TEST_RATE_LIMIT_PER_MIN,
    );
    if (!limit.allowed) {
      return c.json(
        { code: 429, message: `试跑过于频繁（${config.PROMPT_TEST_RATE_LIMIT_PER_MIN} 次/分钟）` },
        429,
      );
    }

    const body = await readJsonBody(c);
    let promptText: string;
    let promptHash: string;

    if (typeof body?.prompt === "string" && body.prompt.trim()) {
      const validation = validatePrompt(body.prompt);
      if (validation.ok === false) {
        return c.json({ code: 400, message: validation.message }, 400);
      }
      promptText = body.prompt;
      promptHash = hashPrompt(promptText);
    } else {
      const context = await getPromptContext(userId);
      promptText = context.prompt;
      promptHash = context.promptHash;
    }

    const sample = {
      source: String(body?.sample?.source || DEFAULT_SAMPLE.source),
      title: String(body?.sample?.title || DEFAULT_SAMPLE.title),
      desc: String(body?.sample?.desc || DEFAULT_SAMPLE.desc),
    };

    const meta = extractNewsMetadata(sample);
    if (!meta.formattedText) {
      return c.json({ code: 400, message: "样例内容为空，无法试跑" }, 400);
    }

    const completion = await requestScoreCompletion(promptText, meta.formattedText, {
      timeout: 25000,
    });

    if (!completion.parsed) {
      return c.json({
        code: 200,
        ok: false,
        error: "parse_failed",
        raw: completion.raw,
        latencyMs: completion.latencyMs,
        model: completion.model,
        promptHash,
        hint: "模型输出无法解析为 {score, layer, reason}，请检查 Prompt 的输出格式段落",
      });
    }

    return c.json({
      code: 200,
      ok: true,
      parsed: completion.parsed,
      raw: completion.raw,
      latencyMs: completion.latencyMs,
      model: completion.model,
      usage: completion.usage,
      promptHash,
      warnings: [],
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    logger.error(`❌ [Account] prompt test failed: ${msg}`);
    return c.json({ code: 500, message: `试跑失败: ${msg}` }, 500);
  }
});

export default accountRouter;
