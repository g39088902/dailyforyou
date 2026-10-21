import { config } from "../config.js";
import logger from "./logger.js";
import { executeAffected, executeSql, queryOne, queryRows, runBatch } from "../db/client.js";
import type { AuthProviderId } from "../types.js";

export interface UserRow {
  id: number;
  display_name: string;
  status: string;
  token_version: number;
  created_at: string;
  updated_at: string;
}

export interface AuthIdentityRow {
  id: number;
  user_id: number;
  provider: AuthProviderId;
  provider_user_id: string;
  provider_meta: string;
  created_at: string;
  last_login_at: string | null;
}

export interface AuthNonceRow {
  nonce: string;
  address: string;
  provider: string;
  message: string;
  issued_at: string;
  expires_at: string;
  consumed_at: string | null;
  attempts: number;
}

const mapUser = (row: any): UserRow => ({
  id: Number(row.id),
  display_name: String(row.display_name || ""),
  status: String(row.status || "active"),
  token_version: Number(row.token_version ?? 0),
  created_at: String(row.created_at || ""),
  updated_at: String(row.updated_at || ""),
});

/**
 * 按 ID 查询用户
 */
export const getUserById = async (userId: number): Promise<UserRow | null> => {
  const row = await queryOne(`SELECT * FROM users WHERE id = ? LIMIT 1`, [userId]);
  return row ? mapUser(row) : null;
};

/**
 * 按 provider + 平台唯一标识查询身份
 */
export const getIdentity = async (
  provider: AuthProviderId,
  providerUserId: string,
): Promise<AuthIdentityRow | null> => {
  const row = await queryOne(
    `SELECT * FROM auth_identities WHERE provider = ? AND provider_user_id = ? LIMIT 1`,
    [provider, providerUserId],
  );
  if (!row) return null;
  return {
    id: Number(row.id),
    user_id: Number(row.user_id),
    provider: String(row.provider) as AuthProviderId,
    provider_user_id: String(row.provider_user_id),
    provider_meta: String(row.provider_meta || "{}"),
    created_at: String(row.created_at || ""),
    last_login_at: row.last_login_at ? String(row.last_login_at) : null,
  };
};

/**
 * 绑定身份到用户（已存在则忽略，不覆盖归属）
 */
export const bindIdentity = async (
  userId: number,
  provider: AuthProviderId,
  providerUserId: string,
  meta: Record<string, unknown> = {},
): Promise<boolean> => {
  const now = new Date().toISOString();
  const changed = await executeAffected(
    `INSERT INTO auth_identities (user_id, provider, provider_user_id, provider_meta, created_at, last_login_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider, provider_user_id) DO NOTHING`,
    [userId, provider, providerUserId, JSON.stringify(meta), now, now],
  );
  return changed > 0;
};

const createUser = async (displayName: string): Promise<number> => {
  const now = new Date().toISOString();
  const row = await queryOne(
    `INSERT INTO users (display_name, status, token_version, created_at, updated_at)
     VALUES (?, 'active', 0, ?, ?)
     RETURNING id`,
    [displayName, now, now],
  );
  const id = Number(row?.id ?? 0);
  if (!id) throw new Error("创建用户失败：未返回自增 ID");
  return id;
};

/**
 * 按钱包地址查找或创建用户
 *  - 已绑定：直接返回该用户
 *  - 未绑定且地址等于 DEFAULT_USER_ADDRESS：认领默认账户（迁移存量数据的归属）
 *  - 其余：新建用户
 */
export const findOrCreateUserByWallet = async (
  addressLower: string,
  meta: Record<string, unknown> = {},
): Promise<{ user: UserRow; isNew: boolean; claimedDefault: boolean }> => {
  const existing = await getIdentity("ethereum", addressLower);
  if (existing) {
    await executeSql(`UPDATE auth_identities SET last_login_at = ? WHERE id = ?`, [
      new Date().toISOString(),
      existing.id,
    ]);
    const user = await getUserById(existing.user_id);
    if (!user) throw new Error("身份指向的用户不存在");
    return { user, isNew: false, claimedDefault: user.id === config.DEFAULT_USER_ID };
  }

  const defaultAddress = (config.DEFAULT_USER_ADDRESS || "").trim().toLowerCase();
  if (defaultAddress && addressLower === defaultAddress) {
    const defaultUser = await getUserById(config.DEFAULT_USER_ID);
    if (defaultUser) {
      const bound = await bindIdentity(config.DEFAULT_USER_ID, "ethereum", addressLower, meta);
      if (bound) {
        logger.info(
          `🔗 [Auth] 钱包 ${addressLower} 已认领默认账户 user_id=${config.DEFAULT_USER_ID}`,
        );
      }
      return { user: defaultUser, isNew: false, claimedDefault: true };
    }
  }

  const displayName = `${addressLower.slice(0, 6)}…${addressLower.slice(-4)}`;
  const userId = await createUser(displayName);
  await bindIdentity(userId, "ethereum", addressLower, meta);
  const user = await getUserById(userId);
  if (!user) throw new Error("创建用户后回读失败");
  return { user, isNew: true, claimedDefault: false };
};

/**
 * 启动时把 DEFAULT_USER_ADDRESS 绑定到默认账户（幂等）
 */
export const bindDefaultUserIdentity = async (): Promise<void> => {
  const address = (config.DEFAULT_USER_ADDRESS || "").trim().toLowerCase();
  if (!address) {
    logger.warn(
      "⚠️ [Auth] 未配置 DEFAULT_USER_ADDRESS：历史数据归属默认账户，目前无法通过钱包登录访问。" +
        "在 backend/.env 中设置该地址后重启即可认领。",
    );
    return;
  }
  if (!/^0x[0-9a-f]{40}$/.test(address)) {
    logger.error(`❌ [Auth] DEFAULT_USER_ADDRESS 格式非法：${address}`);
    return;
  }

  const existing = await getIdentity("ethereum", address);
  if (existing) {
    if (existing.user_id !== config.DEFAULT_USER_ID) {
      logger.error(
        `❌ [Auth] ${address} 已绑定到 user_id=${existing.user_id}，与 DEFAULT_USER_ID=${config.DEFAULT_USER_ID} 冲突，已跳过。`,
      );
    }
    return;
  }

  const defaultUser = await getUserById(config.DEFAULT_USER_ID);
  if (!defaultUser) {
    logger.error("❌ [Auth] 默认账户不存在，无法绑定 DEFAULT_USER_ADDRESS");
    return;
  }

  await bindIdentity(config.DEFAULT_USER_ID, "ethereum", address, { source: "env" });
  logger.info(`🔗 [Auth] DEFAULT_USER_ADDRESS ${address} 已绑定到默认账户`);
};

/**
 * 创建一次性登录挑战（时间戳由调用方生成，保证与待签消息完全一致）
 */
export const createAuthNonce = async (params: {
  nonce: string;
  address: string;
  provider?: AuthProviderId;
  message: string;
  issuedAt: string;
  expiresAt: string;
}): Promise<void> => {
  await executeSql(
    `INSERT INTO auth_nonces (nonce, address, provider, message, issued_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      params.nonce,
      params.address,
      params.provider || "ethereum",
      params.message,
      params.issuedAt,
      params.expiresAt,
    ],
  );
};

/**
 * 查询挑战记录
 */
export const getAuthNonce = async (nonce: string): Promise<AuthNonceRow | null> => {
  const row = await queryOne(`SELECT * FROM auth_nonces WHERE nonce = ? LIMIT 1`, [nonce]);
  if (!row) return null;
  return {
    nonce: String(row.nonce),
    address: String(row.address),
    provider: String(row.provider || "ethereum"),
    message: String(row.message),
    issued_at: String(row.issued_at),
    expires_at: String(row.expires_at),
    consumed_at: row.consumed_at ? String(row.consumed_at) : null,
    attempts: Number(row.attempts ?? 0),
  };
};

/**
 * 原子消费挑战（并发重放只会成功一次）
 */
export const consumeAuthNonce = async (nonce: string): Promise<boolean> => {
  const changed = await executeAffected(
    `UPDATE auth_nonces SET consumed_at = ? WHERE nonce = ? AND consumed_at IS NULL`,
    [new Date().toISOString(), nonce],
  );
  return changed === 1;
};

/**
 * 累加失败次数，超过阈值直接烧掉挑战
 */
export const recordNonceFailure = async (nonce: string, burnAt = 5): Promise<number> => {
  await executeSql(`UPDATE auth_nonces SET attempts = attempts + 1 WHERE nonce = ?`, [nonce]);
  const row = await queryOne(`SELECT attempts FROM auth_nonces WHERE nonce = ? LIMIT 1`, [nonce]);
  const attempts = Number(row?.attempts ?? 0);
  if (attempts >= burnAt) {
    await executeSql(
      `UPDATE auth_nonces SET consumed_at = COALESCE(consumed_at, ?) WHERE nonce = ?`,
      [new Date().toISOString(), nonce],
    );
  }
  return attempts;
};

/**
 * 清理过期挑战（保留一天，便于排查）
 */
export const purgeExpiredNonces = async (): Promise<void> => {
  const before = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  await executeSql(`DELETE FROM auth_nonces WHERE expires_at < ?`, [before]);
};

/**
 * 统计某地址在时间窗内的挑战数量（用于限流判断）
 */
export const countRecentNonces = async (address: string, windowSeconds = 60): Promise<number> => {
  const since = new Date(Date.now() - windowSeconds * 1000).toISOString();
  const row = await queryOne(
    `SELECT COUNT(*) AS total FROM auth_nonces WHERE address = ? AND issued_at >= ?`,
    [address, since],
  );
  return Number(row?.total ?? 0);
};

/**
 * 查询用户全部身份（供 /account/profile 展示可绑定渠道）
 */
export const listIdentitiesByUser = async (userId: number): Promise<AuthIdentityRow[]> => {
  const rows = await queryRows(
    `SELECT * FROM auth_identities WHERE user_id = ? ORDER BY id ASC`,
    [userId],
  );
  return rows.map((row) => ({
    id: Number(row.id),
    user_id: Number(row.user_id),
    provider: String(row.provider) as AuthProviderId,
    provider_user_id: String(row.provider_user_id),
    provider_meta: String(row.provider_meta || "{}"),
    created_at: String(row.created_at || ""),
    last_login_at: row.last_login_at ? String(row.last_login_at) : null,
  }));
};

/**
 * 批量写入（供将来的多 provider 合并使用）
 */
export const rebindIdentities = async (
  statements: Array<{ sql: string; args: Array<string | number | null> }>,
): Promise<void> => {
  await runBatch(statements);
};
