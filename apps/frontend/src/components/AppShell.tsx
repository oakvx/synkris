import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";

import { useAuth } from "../auth/AuthContext";

export function AppShell({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();

  return (
    <div className="portal-layout">
      <aside className="sidebar">
        <div className="brand-block">
          <p className="eyebrow">Frontend localhost</p>
          <h1>WhatsApp AI Portal</h1>
          <p className="muted">
            Dashboard statica che parla solo con API locali. Sessioni WhatsApp e database restano lato server.
          </p>
        </div>

        <nav className="nav-links">
          <NavLink to="/" end>
            Dashboard
          </NavLink>
          <NavLink to="/connect">Connetti WhatsApp</NavLink>
          <NavLink to="/database">Database bot</NavLink>
          <NavLink to="/settings">Impostazioni</NavLink>
        </nav>

        <div className="account-box">
          <div>
            <strong>{user?.displayName ?? user?.email}</strong>
            <p className="muted">{user?.email}</p>
          </div>
          <button className="ghost-button" onClick={logout} type="button">
            Esci
          </button>
        </div>
      </aside>

      <main className="content-area">{children}</main>
    </div>
  );
}
