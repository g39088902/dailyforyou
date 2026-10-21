import type { Get, Post } from "../types.js";
import { config } from "../config.js";
import logger from "./logger.js";
import axios from "axios";

// 基础配置
const request = axios.create({
  // 请求超时设置
  timeout: config.REQUEST_TIMEOUT,
  withCredentials: true,
});

// 请求拦截
request.interceptors.request.use(
  (request) => {
    if (!request.params) request.params = {};
    // 发送请求
    return request;
  },
  (error) => {
    logger.error("❌ [ERROR] request failed");
    return Promise.reject(error);
  },
);

// 响应拦截
request.interceptors.response.use(
  (response) => {
    return response;
  },
  (error) => {
    // 继续传递错误
    return Promise.reject(error);
  },
);

export interface RequestResult<T = unknown> {
  /** 历史字段：进程内缓存移除后恒为 false，保留是为了不改变适配器的返回结构 */
  fromCache: boolean;
  updateTime: string;
  data: T;
}

// GET
export const get = async <T = unknown>(options: Get): Promise<RequestResult<T>> => {
  // noCache / ttl 仍在 Get 类型中保留：130+ 个适配器都在传，删字段会波及全部适配器。
  // 进程内缓存已移除，这两个参数不再产生任何行为。
  const { url, headers, params, originaInfo = false, responseType = "json" } = options;
  logger.info(`🌐 [GET] ${url}`);
  try {
    const response = await request.get(url, { headers, params, responseType });
    const responseData = response?.data || response;
    const updateTime = new Date().toISOString();
    const data = originaInfo ? response : responseData;
    logger.info(`✅ [${response?.status}] request was successful`);
    return { fromCache: false, updateTime, data: data as T };
  } catch (error) {
    logger.error("❌ [ERROR] request failed");
    throw error;
  }
};

// POST
export const post = async <T = unknown>(options: Post): Promise<RequestResult<T>> => {
  const { url, headers, body, originaInfo = false } = options;
  logger.info(`🌐 [POST] ${url}`);
  try {
    const response = await request.post(url, body, { headers });
    const responseData = response?.data || response;
    const updateTime = new Date().toISOString();
    const data = originaInfo ? response : responseData;
    logger.info(`✅ [${response?.status}] request was successful`);
    return { fromCache: false, updateTime, data: data as T };
  } catch (error) {
    logger.error("❌ [ERROR] request failed");
    throw error;
  }
};
