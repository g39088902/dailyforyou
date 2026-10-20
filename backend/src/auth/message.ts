import { config } from "../config.js";

export interface SiweMessageParams {
  domain: string;
  address: string;
  uri: string;
  chainId: number;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}

/**
 * 解析登录消息域名（AUTH_DOMAIN > ALLOWED_HOST > localhost:6688）
 */
export const resolveAuthDomain = (): string => {
  const configured = (config.AUTH_DOMAIN || "").trim();
  if (configured) return configured;
  const host = (config.ALLOWED_HOST || "").trim();
  if (host && host !== "*") return host;
  return `localhost:${config.PORT}`;
};

/**
 * 解析登录消息 URI（AUTH_URI > http://domain）
 */
export const resolveAuthUri = (): string => {
  const configured = (config.AUTH_URI || "").trim();
  if (configured) return configured;
  return `http://${resolveAuthDomain()}`;
};

/**
 * 构造 SIWE 风格的待签名消息（客户端原样签名，服务端逐字比对）
 */
export const buildSiweMessage = (params: SiweMessageParams): string =>
  [
    `${params.domain} wants you to sign in with your Ethereum account:`,
    params.address,
    "",
    "Sign in to DailyForYou. This request will not trigger a blockchain transaction or cost any gas.",
    "",
    `URI: ${params.uri}`,
    "Version: 1",
    `Chain ID: ${params.chainId}`,
    `Nonce: ${params.nonce}`,
    `Issued At: ${params.issuedAt}`,
    `Expiration Time: ${params.expiresAt}`,
  ].join("\n");

const NONCE_LINE = /^Nonce:\s*(\S+)\s*$/m;
const ADDRESS_LINE = /wants you to sign in with your Ethereum account:\s*\n(0x[0-9a-fA-F]{40})/;

/**
 * 从消息中提取 nonce
 */
export const extractNonce = (message: string): string | null => {
  const matched = NONCE_LINE.exec(message);
  return matched ? matched[1] : null;
};

/**
 * 从消息中提取钱包地址（仅用于日志与一致性校验）
 */
export const extractAddress = (message: string): string | null => {
  const matched = ADDRESS_LINE.exec(message);
  return matched ? matched[1].toLowerCase() : null;
};
