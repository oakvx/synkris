import { createContext } from "react";

import type { PortalUser } from "@whatsapp-ai/shared";

export type AuthContextValue = {
  token: string | null;
  user: PortalUser | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, displayName: string) => Promise<void>;
  logout: () => void;
};

export const AuthContext = createContext<AuthContextValue | null>(null);
