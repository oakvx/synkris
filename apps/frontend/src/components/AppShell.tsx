import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { isSystemAdminRole } from "@whatsapp-ai/shared";

import { useAuth } from "../auth/useAuth";

const navItems = [
  { to: "/", label: "Dashboard", hint: "Panoramica e stato bot" },
  { to: "/connect", label: "Connetti WhatsApp", hint: "QR, pairing e sessione" },
  { to: "/database", label: "Database bot", hint: "Tabelle, righe e campi" },
  { to: "/settings", label: "Impostazioni", hint: "Preferenze account e default" },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const canManageBotData = isSystemAdminRole(user?.role);
  const visibleNavItems = navItems.filter((item) => canManageBotData || item.to !== "/database");

  return (
    <div className="portal-layout">
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="brand-block">
            <p className="eyebrow">Frontend localhost</p>
            <h1>WhatsApp AI Portal</h1>
            <p className="muted">
              Dashboard locale che controlla il bot reale, lo stato della sessione e i dati operativi.
            </p>
          </div>
        </div>

        <nav className="nav-links">
          {visibleNavItems.map((item) => (
            <NavLink end={item.to === "/"} key={item.to} to={item.to}>
              <span className="nav-label">{item.label}</span>
              <span className="nav-hint">{item.hint}</span>
            </NavLink>
          ))}
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

      <main className="content-area">
        <header className="shell-topbar">
          <div>
            <p className="eyebrow">Gestionale operativo</p>
            <h2 className="shell-title">Controllo bot, sessione e dati</h2>
          </div>
          <div className="shell-topbar-meta">
            <span className="meta-pill">Ambiente locale</span>
            <span className="meta-pill">{user?.role ?? "user"}</span>
          </div>
        </header>
        <div className="content-stack">{children}</div>
      </main>
    </div>
  );
}
