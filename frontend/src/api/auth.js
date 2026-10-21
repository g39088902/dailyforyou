import axios from "@/api/request";

/**
 * 可用登录渠道
 */
export const getAuthProviders = () => {
  return axios({
    method: "GET",
    url: "/auth/providers",
  });
};

/**
 * 申请一次性签名挑战
 * @param {string} address 钱包地址
 * @param {number} chainId 链 ID
 */
export const getAuthNonce = (address, chainId = 1) => {
  return axios({
    method: "POST",
    url: "/auth/nonce",
    data: { address, chainId },
  });
};

/**
 * 提交签名换取 JWT
 * @param {{message: string, signature: string}} payload
 */
export const verifyWalletSignature = (payload) => {
  return axios({
    method: "POST",
    url: "/auth/verify",
    data: payload,
    timeout: 30000,
  });
};

export const logoutAuth = () => {
  return axios({
    method: "POST",
    url: "/auth/logout",
  });
};

export const getAccountProfile = () => {
  return axios({
    method: "GET",
    url: "/account/profile",
  });
};

export const getAccountPrompt = () => {
  return axios({
    method: "GET",
    url: "/account/prompt",
  });
};

/**
 * 保存自定义 Prompt
 * @param {string} prompt
 */
export const updateAccountPrompt = (prompt) => {
  return axios({
    method: "PUT",
    url: "/account/prompt",
    data: { prompt },
    timeout: 30000,
  });
};

export const resetAccountPrompt = () => {
  return axios({
    method: "POST",
    url: "/account/prompt/reset",
  });
};

/**
 * 试跑 Prompt（不落库）
 * @param {{prompt?: string, sample?: object}} payload
 */
export const testAccountPrompt = (payload = {}) => {
  return axios({
    method: "POST",
    url: "/account/prompt/test",
    data: payload,
    timeout: 40000,
    silentError: true,
  });
};
