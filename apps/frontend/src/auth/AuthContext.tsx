import type { PortalUser } from "@whatsapp-ai/shared";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { apiClient } from "../lib/api";

type AuthContextValue = {
  token: string | null;
  user: PortalUser | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, displayName: string) => Promise<void>;
  logout: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);
const storageKey = "whatsapp-ai.portal.token";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(storageKey));
  const [user, setUser] = useState<PortalUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let active = true;

    async function bootstrap() {
      if (!token) {
        if (active) {
          setUser(null);
          setIsLoading(false);
        }
        return;
      }

      try {
        const currentUser = await apiClient.me(token);
        if (active) {
          setUser(currentUser);
        }
      } catch {
        if (active) {
          localStorage.removeItem(storageKey);
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
  }, [token]);

  const value = useMemo<AuthContextValue>(
    () => ({
      token,
      user,
      isLoading,
      async login(email, password) {
        const result = await apiClient.login(email, password);
        localStorage.setItem(storageKey, result.token);
        setToken(result.token);
        setUser(result.user);
      },
      async register(email, password, displayName) {
        const result = await apiClient.register(email, password, displayName);
        localStorage.setItem(storageKey, result.token);
        setToken(result.token);
        setUser(result.user);
      },
      logout() {
        localStorage.removeItem(storageKey);
        setToken(null);
        setUser(null);
      },
    }),
    [isLoading, token, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error("useAuth must be used inside AuthProvider");
  }

  return value;
}
