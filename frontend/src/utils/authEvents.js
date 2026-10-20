/**
 * 极简鉴权事件总线
 * 目的：避免 request.js → store → api 之间的循环依赖
 */
const listeners = new Map();

export const onAuthEvent = (name, handler) => {
  if (!listeners.has(name)) listeners.set(name, new Set());
  listeners.get(name).add(handler);
  return () => {
    listeners.get(name)?.delete(handler);
  };
};

export const emitAuthEvent = (name, payload) => {
  const handlers = listeners.get(name);
  if (!handlers) return;
  for (const handler of handlers) {
    try {
      handler(payload);
    } catch (error) {
      console.error(`[authEvents] handler error for ${name}:`, error);
    }
  }
};

export const AUTH_EVENTS = {
  UNAUTHORIZED: "dfy:unauthorized",
  IDENTITY_CHANGED: "dfy:identity-changed",
  OPEN_LOGIN: "dfy:open-login",
};
