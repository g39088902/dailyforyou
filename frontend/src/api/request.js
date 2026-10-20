import axios from "axios";
import { AUTH_EVENTS, emitAuthEvent } from "@/utils/authEvents";

// 与 store/auth.js 保持一致（此处不 import store，避免循环依赖）
const TOKEN_KEY = "dfy.auth.token";
const USER_KEY = "dfy.auth.user";

switch (process.env.NODE_ENV) {
  case "production":
    axios.defaults.baseURL = import.meta.env.VITE_GLOBAL_API;
    break;
  case "development":
    axios.defaults.baseURL = import.meta.env.VITE_GLOBAL_API;
    break;
  default:
    axios.defaults.baseURL = import.meta.env.VITE_GLOBAL_API;
    break;
}

axios.defaults.timeout = 30000;
axios.defaults.headers = { "Content-Type": "application/json" };

let lastUnauthorizedAt = 0;

// 请求拦截
axios.interceptors.request.use(
  (request) => {
    // if (request.loadingBar != "Hidden") $loadingBar.start();
    const token = localStorage.getItem(TOKEN_KEY);
    if (token) {
      request.headers.Authorization = `Bearer ${token}`;
    }
    return request;
  },
  (error) => {
    // $loadingBar.error();
    $message.error("请求失败，请稍后重试");
    return Promise.reject(error);
  }
);

// 响应拦截
axios.interceptors.response.use(
  (response) => {
    // $loadingBar.finish();
    return response.data;
  },
  (error) => {
    if (error?.config?.silentError) {
      return Promise.reject(error);
    }
    $loadingBar.error();

    if (error.response) {
      const data = error.response.data || {};
      switch (error.response.status) {
        case 401: {
          // 仅在本地确实持有令牌时清理并提示，避免匿名用户被反复弹窗
          const hadToken = Boolean(localStorage.getItem(TOKEN_KEY));
          localStorage.removeItem(TOKEN_KEY);
          localStorage.removeItem(USER_KEY);

          if (hadToken) {
            emitAuthEvent(AUTH_EVENTS.UNAUTHORIZED, {
              message: data.message || "登录状态已失效",
            });
            if (Date.now() - lastUnauthorizedAt > 3000) {
              lastUnauthorizedAt = Date.now();
              $message.error(data.message || "登录状态已失效，请重新登录");
            }
          }
          break;
        }
        case 301:
          $message.error(data.message ? data.message : "请求路径发生跳转");
          break;
        case 403:
          $message.error(data.message ? data.message : "暂无访问权限");
          break;
        case 404:
          $message.error(data.message ? data.message : "请求资源不存在");
          break;
        case 429:
          $message.error(data.message ? data.message : "请求过于频繁，请稍后再试");
          break;
        case 500:
          $message.error(data.message ? data.message : "内部服务器错误");
          break;
        default:
          $message.error(data.message ? data.message : "请求失败，请稍后重试");
          break;
      }
    } else {
      $message.error("请求失败，请稍后重试");
    }
    return Promise.reject(error);
  }
);

export default axios;
