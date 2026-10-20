import { defineStore } from "pinia";
import { AUTH_EVENTS, emitAuthEvent } from "@/utils/authEvents";

export const TOKEN_KEY = "dfy.auth.token";
export const USER_KEY = "dfy.auth.user";

const readStoredUser = () => {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

export const useAuthStore = defineStore("auth", {
  state: () => ({
    token: localStorage.getItem(TOKEN_KEY) || "",
    user: readStoredUser(),
    // idle | anon | authed
    status: "idle",
  }),

  getters: {
    isAuthed: (state) => Boolean(state.token && state.user),
    userId: (state) => state.user?.id ?? null,
    address: (state) => state.user?.address || "",
    displayName: (state) => state.user?.displayName || "",
    isDefaultAccount: (state) => Boolean(state.user?.isDefaultAccount),
    promptHash: (state) => state.user?.promptHash || "",
    shortAddress: (state) => {
      const address = state.user?.address || "";
      if (!address) return "";
      return `${address.slice(0, 6)}…${address.slice(-4)}`;
    },
  },

  actions: {
    setSession({ token, user }) {
      this.token = token || "";
      this.user = user || null;
      this.status = token && user ? "authed" : "anon";
      localStorage.setItem(TOKEN_KEY, this.token);
      localStorage.setItem(USER_KEY, JSON.stringify(this.user));
      emitAuthEvent(AUTH_EVENTS.IDENTITY_CHANGED, {
        user: this.user,
        reason: "login",
      });
    },

    updateUser(patch) {
      if (!this.user) return;
      this.user = { ...this.user, ...patch };
      localStorage.setItem(USER_KEY, JSON.stringify(this.user));
      emitAuthEvent(AUTH_EVENTS.IDENTITY_CHANGED, {
        user: this.user,
        reason: "update",
      });
    },

    clearSession(reason = "logout") {
      const previous = this.user;
      this.token = "";
      this.user = null;
      this.status = "anon";
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
      emitAuthEvent(AUTH_EVENTS.IDENTITY_CHANGED, {
        user: null,
        previous,
        reason,
      });
    },

    hydrate() {
      this.status = this.isAuthed ? "authed" : "anon";
    },
  },
});
