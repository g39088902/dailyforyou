/**
 * MetaMask / EIP-1193 钱包适配（零额外依赖，直接使用 window.ethereum）
 */

export const hasWallet = () =>
  typeof window !== "undefined" && Boolean(window.ethereum);

/**
 * 请求连接钱包
 * @returns {Promise<{address: string, chainId: number}>}
 */
export const connectWallet = async () => {
  if (!hasWallet()) {
    throw new Error("NO_WALLET");
  }
  const accounts = await window.ethereum.request({
    method: "eth_requestAccounts",
  });
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new Error("NO_ACCOUNT");
  }
  const chainIdHex = await window.ethereum.request({ method: "eth_chainId" });
  const chainId = Number.parseInt(chainIdHex, 16) || 1;
  return { address: accounts[0], chainId };
};

/**
 * 将文本编码为 0x 十六进制（personal_sign 要求）
 */
const toHexMessage = (text) => {
  const bytes = new TextEncoder().encode(text);
  let hex = "0x";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
};

/**
 * 请求钱包对消息签名
 */
export const personalSign = async (message, address) => {
  if (!hasWallet()) throw new Error("NO_WALLET");
  return window.ethereum.request({
    method: "personal_sign",
    params: [toHexMessage(message), address],
  });
};

/**
 * 监听账户切换（登录后若用户切换钱包，交由页面提示重新登录）
 */
export const onAccountsChanged = (handler) => {
  if (!hasWallet() || typeof window.ethereum.on !== "function") return () => {};
  window.ethereum.on("accountsChanged", handler);
  return () => {
    window.ethereum.removeListener?.("accountsChanged", handler);
  };
};

/**
 * 将钱包错误翻译为可读文案
 */
export const describeWalletError = (error) => {
  const code = error?.code ?? error?.data?.code;
  if (code === 4001) return "你已取消签名";
  if (code === -32002) return "钱包已弹出请求，请在 MetaMask 中完成操作";
  if (code === 4902) return "钱包尚未添加该网络";
  if (error?.message === "NO_WALLET") return "未检测到 MetaMask，请先安装浏览器插件";
  if (error?.message === "NO_ACCOUNT") return "钱包未返回任何账户";
  return error?.message || "钱包操作失败，请重试";
};
