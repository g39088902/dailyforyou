import dotenv from "dotenv";

// 环境变量
dotenv.config();

export type Config = {
  PORT: number;
  HOST: string;
  ALLOWED_DOMAIN: string;
  ALLOWED_HOST: string;
  USE_LOG_FILE: boolean;
  DEEPSEEK_API_KEY: string;
  DEEPSEEK_BASE_URL: string;
  DEEPSEEK_MODEL: string;
  DEEPSEEK_THINKING: string;
  DEEPSEEK_REASONING_EFFORT: string;
  DEEPSEEK_MAX_TOKENS: number;
  DEEPSEEK_TEMPERATURE: number;
  DEEPSEEK_JSON_MODE: boolean;
  SQLITE_DB_PATH: string;
  LIBSQL_URL: string;
  LIBSQL_AUTH_TOKEN: string;
  AUTH_JWT_SECRET: string;
  AUTH_JWT_TTL: number;
  AUTH_NONCE_TTL: number;
  AUTH_DOMAIN: string;
  AUTH_URI: string;
  AUTH_ALLOWED_CHAIN_IDS: string;
  AUTH_RATE_LIMIT_PER_MIN: number;
  DEFAULT_USER_ID: number;
  DEFAULT_USER_ADDRESS: string;
  SCORE_PROMPT_MAX_LENGTH: number;
  SCORE_RATE_LIMIT_PER_MIN: number;
  PROMPT_TEST_RATE_LIMIT_PER_MIN: number;
  CRAWL_INTERVAL_MINUTES: number;
};

// 验证并提取环境变量
const getEnvVariable = (key: string): string | undefined => {
  const value = process.env[key];
  if (value === undefined) return undefined;
  return value;
};

// 将环境变量转换为数值
const getNumericEnvVariable = (key: string, defaultValue: number): number => {
  const value = getEnvVariable(key) ?? String(defaultValue);
  const parsedValue = parseInt(value, 10);
  if (isNaN(parsedValue)) return defaultValue;
  return parsedValue;
};

// 将环境变量转换为布尔值
const getBooleanEnvVariable = (key: string, defaultValue: boolean): boolean => {
  const value = getEnvVariable(key) ?? String(defaultValue);
  return value.toLowerCase() === "true";
};

// 创建配置对象（用户服务：只管用户、评分、Prompt，不抓取新闻）
export const config: Config = {
  PORT: getNumericEnvVariable("PORT", 6690),
  // 默认监听全部网卡（本地开发方便）；公网部署时设为 127.0.0.1，只允许 Nginx 反代访问
  HOST: getEnvVariable("HOST") || "0.0.0.0",
  ALLOWED_DOMAIN: getEnvVariable("ALLOWED_DOMAIN") || "*",
  ALLOWED_HOST: getEnvVariable("ALLOWED_HOST") || "imsyy.top",
  USE_LOG_FILE: getBooleanEnvVariable("USE_LOG_FILE", true),
  DEEPSEEK_API_KEY: getEnvVariable("DEEPSEEK_API_KEY") || "",
  DEEPSEEK_BASE_URL: getEnvVariable("DEEPSEEK_BASE_URL") || "https://api.deepseek.com",
  DEEPSEEK_MODEL: getEnvVariable("DEEPSEEK_MODEL") || "deepseek-flash",
  // 评分策略：准确性优先，默认走最高档思考（max）。降档必须先有同档位自一致性基线 + A/B 数据支撑。
  // 取值：enabled / disabled / 留空（留空则不下发该字段，走服务端默认=开启思考、effort=high）
  DEEPSEEK_THINKING: (getEnvVariable("DEEPSEEK_THINKING") ?? "enabled").trim(),
  // 思考强度：none / low / high / max，留空则不下发；thinking=disabled 时该值会被忽略（none 除外）
  DEEPSEEK_REASONING_EFFORT: (getEnvVariable("DEEPSEEK_REASONING_EFFORT") ?? "max").trim(),
  // 输出上限（含思考 token）。0 表示不下发，此时思考模式默认 64K、非思考模式默认 8K。
  // max 档实测单条思考 + 正文峰值约 1.1K，8192 留足余量，避免截断导致 JSON 解析失败。
  DEEPSEEK_MAX_TOKENS: getNumericEnvVariable("DEEPSEEK_MAX_TOKENS", 8192),
  // 采样温度（思考模式下通常被服务端忽略）
  DEEPSEEK_TEMPERATURE: Number(getEnvVariable("DEEPSEEK_TEMPERATURE") ?? "0.1"),
  // JSON 模式：自定义 Prompt 未要求输出 JSON 时可能导致空输出，默认关闭
  DEEPSEEK_JSON_MODE: getBooleanEnvVariable("DEEPSEEK_JSON_MODE", false),
  SQLITE_DB_PATH: getEnvVariable("SQLITE_DB_PATH") || "./data/users.sqlite",
  LIBSQL_URL: getEnvVariable("LIBSQL_URL") || "",
  LIBSQL_AUTH_TOKEN: getEnvVariable("LIBSQL_AUTH_TOKEN") || "",
  AUTH_JWT_SECRET: getEnvVariable("AUTH_JWT_SECRET") || "",
  AUTH_JWT_TTL: getNumericEnvVariable("AUTH_JWT_TTL", 604800),
  AUTH_NONCE_TTL: getNumericEnvVariable("AUTH_NONCE_TTL", 300),
  AUTH_DOMAIN: getEnvVariable("AUTH_DOMAIN") || "",
  AUTH_URI: getEnvVariable("AUTH_URI") || "",
  AUTH_ALLOWED_CHAIN_IDS: getEnvVariable("AUTH_ALLOWED_CHAIN_IDS") || "",
  AUTH_RATE_LIMIT_PER_MIN: getNumericEnvVariable("AUTH_RATE_LIMIT_PER_MIN", 10),
  DEFAULT_USER_ID: getNumericEnvVariable("DEFAULT_USER_ID", 1),
  DEFAULT_USER_ADDRESS: getEnvVariable("DEFAULT_USER_ADDRESS") || "",
  SCORE_PROMPT_MAX_LENGTH: getNumericEnvVariable("SCORE_PROMPT_MAX_LENGTH", 20000),
  SCORE_RATE_LIMIT_PER_MIN: getNumericEnvVariable("SCORE_RATE_LIMIT_PER_MIN", 600),
  PROMPT_TEST_RATE_LIMIT_PER_MIN: getNumericEnvVariable("PROMPT_TEST_RATE_LIMIT_PER_MIN", 5),
  CRAWL_INTERVAL_MINUTES: getNumericEnvVariable("CRAWL_INTERVAL_MINUTES", 120),
};
