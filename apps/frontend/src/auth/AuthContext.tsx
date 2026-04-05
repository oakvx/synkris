import type { PortalUser } from "@whatsapp-ai/shared";
import {
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { apiClient } from "../lib/api";
import { AuthContext, type AuthContextValue } from "./auth-context";
const cookieSessionToken = "session";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<PortalUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let active = true;

    async function bootstrap() {
      try {
        const currentUser = await apiClient.me();
        if (active) {
          setUser(currentUser);
          setToken(cookieSessionToken);
        }
      } catch {
        if (active) {
          setToken(null);
          setUser(null);
        }
      } finally {
        if (active) {
          setIsLoading(false);
        }
      }
    }

    void bootstrap();

    return () => {
      active = false;
    };
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      token,
      user,
      isLoading,
      async login(email, password) {
        const result = await apiClient.login(email, password);
        setToken(result.token);
        setUser(result.user);
      },
      async register(email, password, displayName) {
        const result = await apiClient.register(email, password, displayName);
        setToken(result.token);
        setUser(result.user);
      },
      logout() {
        void apiClient.logout(token);
        setToken(null);
        setUser(null);
      },
    }),
    [isLoading, token, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
