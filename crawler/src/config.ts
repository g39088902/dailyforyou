import dotenv from "dotenv";

// 环境变量
dotenv.config();

export type Config = {
  PORT: number;
  HOST: string;
  DISALLOW_ROBOT: boolean;
  CACHE_TTL: number;
  REQUEST_TIMEOUT: number;
  ALLOWED_DOMAIN: string;
  ALLOWED_HOST: string;
  USE_LOG_FILE: boolean;
  RSS_MODE: boolean;
  DEEPSEEK_API_KEY: string;
  DEEPSEEK_BASE_URL: string;
  DEEPSEEK_MODEL: string;
  SQLITE_DB_PATH: string;
  LIBSQL_URL: string;
  LIBSQL_AUTH_TOKEN: string;
  NEWS_PERSIST_ENABLED: boolean;
};

const getEnvVariable = (key: string): string | undefined => {
  const value = process.env[key];
  if (value === undefined) return undefined;
  return value;
};

const getNumericEnvVariable = (key: string, defaultValue: number): number => {
  const value = getEnvVariable(key) ?? String(defaultValue);
  const parsedValue = parseInt(value, 10);
  if (isNaN(parsedValue)) return defaultValue;
  return parsedValue;
};

const getBooleanEnvVariable = (key: string, defaultValue: boolean): boolean => {
  const value = getEnvVariable(key) ?? String(defaultValue);
  return value.toLowerCase() === "true";
};

export const config: Config = {
  PORT: getNumericEnvVariable("PORT", 6688),
  // 默认监听全部网卡（本地开发方便）；公网部署时设为 127.0.0.1，只允许 Nginx 反代访问
  HOST: getEnvVariable("HOST") || "0.0.0.0",
  DISALLOW_ROBOT: getBooleanEnvVariable("DISALLOW_ROBOT", true),
  CACHE_TTL: getNumericEnvVariable("CACHE_TTL", 3600),
  REQUEST_TIMEOUT: getNumericEnvVariable("REQUEST_TIMEOUT", 6000),
  ALLOWED_DOMAIN: getEnvVariable("ALLOWED_DOMAIN") || "*",
  ALLOWED_HOST: getEnvVariable("ALLOWED_HOST") || "imsyy.top",
  USE_LOG_FILE: getBooleanEnvVariable("USE_LOG_FILE", true),
  RSS_MODE: getBooleanEnvVariable("RSS_MODE", false),
  DEEPSEEK_API_KEY: getEnvVariable("DEEPSEEK_API_KEY") || "",
  DEEPSEEK_BASE_URL: getEnvVariable("DEEPSEEK_BASE_URL") || "https://api.deepseek.com",
  DEEPSEEK_MODEL: getEnvVariable("DEEPSEEK_MODEL") || "deepseek-flash",
  SQLITE_DB_PATH: getEnvVariable("SQLITE_DB_PATH") || "./data/news.sqlite",
  LIBSQL_URL: getEnvVariable("LIBSQL_URL") || "",
  LIBSQL_AUTH_TOKEN: getEnvVariable("LIBSQL_AUTH_TOKEN") || "",
  NEWS_PERSIST_ENABLED: getBooleanEnvVariable("NEWS_PERSIST_ENABLED", true),
};
