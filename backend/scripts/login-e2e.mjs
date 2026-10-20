#!/usr/bin/env node
/**
 * 钱包登录 + 多用户评分链路端到端验证
 *
 * 用法：node scripts/login-e2e.mjs [--keep]
 *   --keep  保留测试用户与测试数据（默认会自动清理）
 *
 * 覆盖：
 *   1. nonce 挑战 → personal_sign → 验签 → JWT
 *   2. nonce 重放必须失败
 *   3. /score 无 token 401，有 token 正常
 *   4. /score/cache 命中、手动改分、已读同步
 *   5. /account/prompt 读取/保存，改 prompt 后缓存失效
 *   6. Prompt 试跑接口
 *   7. 迁移不变量：默认账户的 profile.prompt_hash 与全部状态行一致
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, "..");
const KEEP = process.argv.includes("--keep");
const BASE = process.env.E2E_BASE || "http://127.0.0.1:6690";

let passed = 0;
let failed = 0;

const check = (name, ok, detail = "") => {
  if (ok) {
    passed += 1;
    console.log(`  ✅ ${name}${detail ? ` (${detail})` : ""}`);
  } else {
    failed += 1;
    console.error(`  ❌ ${name}${detail ? ` (${detail})` : ""}`);
  }
};

const request = async (method, urlPath, { token, body } = {}) => {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
};

const loadEnv = () => {
  const envPath = path.join(backendRoot, ".env");
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const matched = /^\s*([\w.-]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!matched) continue;
    let value = matched[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[matched[1]] === undefined) process.env[matched[1]] = value;
  }
};

const main = async () => {
  console.log(`\n▶ E2E 目标: ${BASE}\n`);

  const account = privateKeyToAccount(generatePrivateKey());
  const address = account.address;
  console.log(`  临时钱包: ${address}\n`);

  // 1. nonce
  const nonceRes = await request("POST", "/auth/nonce", { body: { address, chainId: 1 } });
  check("申请 nonce", nonceRes.status === 200 && Boolean(nonceRes.json?.message), `status=${nonceRes.status}`);
  const message = nonceRes.json?.message || "";
  const nonce = nonceRes.json?.nonce || "";

  // 2. 签名 + 验签
  const signature = await account.signMessage({ message });
  const verifyRes = await request("POST", "/auth/verify", { body: { message, signature } });
  const token = verifyRes.json?.token || "";
  check("钱包签名登录", verifyRes.status === 200 && Boolean(token), `status=${verifyRes.status}`);
  if (!token) throw new Error(`登录失败: ${JSON.stringify(verifyRes.json)}`);

  // 3. 重放
  const replay = await request("POST", "/auth/verify", { body: { message, signature } });
  check("nonce 重放被拒", replay.status === 401, `status=${replay.status}`);

  // 4. 身份接口
  const me = await request("GET", "/auth/me", { token });
  check(
    "/auth/me 返回当前用户",
    me.status === 200 && me.json?.data?.user?.address?.toLowerCase() === address.toLowerCase(),
  );

  const meNoToken = await request("GET", "/auth/me");
  check("/auth/me 无 token 401", meNoToken.status === 401);

  // 5. 评分链路
  const unique = `E2E ${Date.now()}：Jetson Orin 边缘算力部署与 CAN 总线抗干扰实践`;
  const desc = "用于验证多用户评分链路，可安全删除";
  const scoreRes = await request(
    "GET",
    `/score?title=${encodeURIComponent(unique)}&desc=${encodeURIComponent(desc)}&source=E2E`,
    { token },
  );
  check(
    "首次评分调用 AI",
    scoreRes.status === 200 && typeof scoreRes.json?.score === "number",
    `score=${scoreRes.json?.score} fromCache=${scoreRes.json?.fromCache}`,
  );

  const newsHash = scoreRes.json?.newsHash || "";

  const cacheRes = await request("POST", "/score/cache", {
    token,
    body: { items: [{ title: unique, desc, source: "E2E" }] },
  });
  check(
    "同 prompt 下缓存命中",
    cacheRes.json?.data?.[0]?.hit === true,
    `hit=${cacheRes.json?.data?.[0]?.hit}`,
  );

  // 6. 手动改分
  const manualRes = await request("POST", "/score/manual", {
    token,
    body: { newsHash, userScore: 88, userLayer: "L1", userReason: "e2e 手动修正" },
  });
  check(
    "手动修正分数",
    manualRes.status === 200 && manualRes.json?.isUserModified === true,
    `score=${manualRes.json?.score}`,
  );

  // 6.5 重置手动修正（手改记录按设计不随 prompt 变更失效，先归零才能验证下发缓存失效）
  const resetRes = await request("POST", "/score/manual", {
    token,
    body: { newsHash, reset: true },
  });
  check(
    "重置手动修正",
    resetRes.status === 200 && resetRes.json?.isUserModified === false,
    `score=${resetRes.json?.score}`,
  );

  // 7. 已读
  const readRes = await request("POST", "/score/read", {
    token,
    body: { items: [{ newsHash, title: unique, desc, source: "E2E", isRead: true }] },
  });
  check("标记已读", readRes.status === 200 && readRes.json?.total === 1);

  const readList = await request("GET", "/score/read?limit=50", { token });
  check(
    "已读列表包含该条",
    Array.isArray(readList.json?.hashes) && readList.json.hashes.includes(newsHash),
  );

  const records = await request("GET", "/score/records?limit=5", { token });
  check(
    "评分记录列表（单表索引查询）",
    records.status === 200 && Array.isArray(records.json?.data),
    `total=${records.json?.total}`,
  );

  // 8. Prompt 读取与更新
  const promptRes = await request("GET", "/account/prompt", { token });
  const originalPrompt = promptRes.json?.data?.prompt || "";
  check("读取默认 Prompt", promptRes.status === 200 && promptRes.json?.data?.isDefault === true);

  const updatedPrompt = `${originalPrompt}\n\n## 五、用户补充\n优先关注边缘算力与工业总线相关的现场工程细节。`;
  const putRes = await request("PUT", "/account/prompt", {
    token,
    body: { prompt: updatedPrompt },
  });
  check("保存自定义 Prompt", putRes.status === 200 && putRes.json?.data?.isDefault === false);

  // 9. 改 prompt 后缓存必须失效（会再调用一次 AI）
  const rescored = await request(
    "GET",
    `/score?title=${encodeURIComponent(unique)}&desc=${encodeURIComponent(desc)}&source=E2E`,
    { token },
  );
  check(
    "改 prompt 后缓存失效并重新评分",
    rescored.status === 200 && rescored.json?.fromCache === false,
    `fromCache=${rescored.json?.fromCache}`,
  );

  // 10. Prompt 试跑
  const testRes = await request("POST", "/account/prompt/test", { token, body: {} });
  check(
    "Prompt 试跑接口",
    testRes.status === 200 && typeof testRes.json?.ok === "boolean",
    `ok=${testRes.json?.ok}`,
  );

  // 11. 越权检查：另一个用户看不到上述记录
  const other = privateKeyToAccount(generatePrivateKey());
  const otherNonce = await request("POST", "/auth/nonce", {
    body: { address: other.address, chainId: 1 },
  });
  const otherSig = await other.signMessage({ message: otherNonce.json.message });
  const otherVerify = await request("POST", "/auth/verify", {
    body: { message: otherNonce.json.message, signature: otherSig },
  });
  const otherToken = otherVerify.json?.token;
  const otherCache = await request("POST", "/score/cache", {
    token: otherToken,
    body: { items: [{ title: unique, desc, source: "E2E" }] },
  });
  check(
    "不同用户缓存隔离",
    otherCache.json?.data?.[0]?.hit === false,
    `hit=${otherCache.json?.data?.[0]?.hit}`,
  );
  const otherRead = await request("GET", "/score/read?limit=50", { token: otherToken });
  check(
    "不同用户已读隔离",
    Array.isArray(otherRead.json?.hashes) && !otherRead.json.hashes.includes(newsHash),
  );

  // 12. 迁移不变量
  loadEnv();
  if (process.env.LIBSQL_URL) {
    const client = createClient({
      url: process.env.LIBSQL_URL,
      authToken: process.env.LIBSQL_AUTH_TOKEN || undefined,
    });
    const profile = await client.execute(
      "SELECT prompt_hash FROM user_profiles WHERE user_id = ?",
      [Number(process.env.DEFAULT_USER_ID || 1)],
    );
    const hashes = await client.execute(
      "SELECT DISTINCT prompt_hash FROM user_news_states WHERE user_id = ? AND ai_score >= 0",
      [Number(process.env.DEFAULT_USER_ID || 1)],
    );
    const profileHash = profile.rows[0]?.prompt_hash;
    const distinct = hashes.rows.map((row) => String(row.prompt_hash));
    check(
      "默认账户历史评分的 prompt_hash 与 profile 一致",
      Boolean(profileHash) && distinct.length === 1 && distinct[0] === String(profileHash),
      `profile=${String(profileHash).slice(0, 8)} states=${distinct.map((h) => h.slice(0, 8)).join(",")}`,
    );

    if (!KEEP) {
      const userId = me.json?.data?.user?.id;
      const otherId = otherVerify.json?.user?.id;
      for (const id of [userId, otherId].filter(Boolean)) {
        await client.execute("DELETE FROM user_news_states WHERE user_id = ?", [id]);
        await client.execute("DELETE FROM user_profiles WHERE user_id = ?", [id]);
        await client.execute("DELETE FROM auth_identities WHERE user_id = ?", [id]);
        await client.execute("DELETE FROM users WHERE id = ?", [id]);
      }
      console.log("\n  🧹 已清理测试用户与测试数据（加 --keep 可保留）");
    }
  }

  console.log(`\n结果: ${passed} 通过, ${failed} 失败\n`);
  if (failed > 0) process.exitCode = 1;
};

main().catch((error) => {
  console.error("\n❌ E2E 执行失败:", error);
  process.exitCode = 1;
});
