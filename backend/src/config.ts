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
  SCORE_RATE_LIMIT_PER_MIN: getNumericEnvVariable("SCORE_RATE_LIMIT_PER_MIN", 240),
  PROMPT_TEST_RATE_LIMIT_PER_MIN: getNumericEnvVariable("PROMPT_TEST_RATE_LIMIT_PER_MIN", 5),
};
