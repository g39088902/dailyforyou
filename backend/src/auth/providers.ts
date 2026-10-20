import type { AuthProviderId } from "../types.js";

export class ProviderNotImplementedError extends Error {
  provider: AuthProviderId;

  constructor(provider: AuthProviderId) {
    super(`provider_not_implemented: ${provider}`);
    this.name = "ProviderNotImplementedError";
    this.provider = provider;
  }
}

export interface AuthProviderInfo {
  id: AuthProviderId;
  label: string;
  enabled: boolean;
  status: "available" | "not_implemented";
  hint?: string;
}

const PROVIDERS: AuthProviderInfo[] = [
  {
    id: "ethereum",
    label: "MetaMask 钱包",
    enabled: true,
    status: "available",
    hint: "使用钱包签名登录，不会发起链上交易，也不消耗 Gas",
  },
  {
    id: "wechat",
    label: "微信扫码",
    enabled: false,
    status: "not_implemented",
    hint: "预留渠道：微信开放平台扫码登录",
  },
  {
    id: "phone",
    label: "手机号",
    enabled: false,
    status: "not_implemented",
    hint: "预留渠道：短信验证码登录",
  },
];

export const listAuthProviders = (): AuthProviderInfo[] =>
  PROVIDERS.map((provider) => ({ ...provider }));

export const isProviderEnabled = (id: AuthProviderId): boolean =>
  Boolean(PROVIDERS.find((provider) => provider.id === id)?.enabled);

export const assertProviderEnabled = (id: AuthProviderId): void => {
  if (!isProviderEnabled(id)) {
    throw new ProviderNotImplementedError(id);
  }
};
