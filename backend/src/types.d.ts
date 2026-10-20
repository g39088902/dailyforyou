// 用户服务类型定义：只包含评分与鉴权，不再包含新闻榜单结构。

// 评分层级与结果类型
export type ScoreLayer = "L1" | "L2" | "L3" | "L4" | "L5" | "Uncertain";

export interface ScoreResult {
  id?: number;
  newsHash?: string;
  score: number;
  layer: ScoreLayer;
  reason: string;
  aiScore?: number;
  aiLayer?: ScoreLayer;
  aiReason?: string;
  userScore?: number | null;
  userLayer?: ScoreLayer | null;
  userReason?: string | null;
  isUserModified?: boolean;
  userUpdatedAt?: string | null;
  isRead?: boolean;
  readAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  fromCache?: boolean;
  degraded?: boolean;
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
