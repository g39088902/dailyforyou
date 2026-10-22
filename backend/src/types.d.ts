// 用户服务类型定义：只包含评分与鉴权，不再包含新闻榜单结构。

export interface ScoreUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** 思维链 token（已计入 completionTokens） */
  reasoningTokens?: number;
  /** 命中上下文缓存的输入 token */
  cachedTokens?: number;
}

export interface ScoreResult {
  id?: number;
  newsHash?: string;
  score: number;
  reason: string;
  aiScore?: number;
  aiReason?: string;
  userScore?: number | null;
  userReason?: string | null;
  isUserModified?: boolean;
  userUpdatedAt?: string | null;
  isRead?: boolean;
  readAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  fromCache?: boolean;
  degraded?: boolean;
  usage?: ScoreUsage | null;
}

// 鉴权相关
export type AuthProviderId = "ethereum" | "wechat" | "phone";

export interface AuthUser {
  userId: number;
  address?: string;
  displayName?: string;
  provider: AuthProviderId | "system";
}

export interface PromptContext {
  prompt: string;
  promptHash: string;
  isDefault: boolean;
}
