import { useEffect, useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { isSystemAdminRole } from "@whatsapp-ai/shared";

import { useAuth } from "../auth/useAuth";
import { ErrorBoundary } from "./ErrorBoundary";

const navItems = [
  { to: "/", label: "Dashboard", hint: "Vista completa" },
  { to: "/operations", label: "Agenda e clienti", hint: "Lavoro di tutti i giorni" },
  { to: "/activity", label: "Storico", hint: "Ultimi eventi e controlli" },
  { to: "/connect", label: "WhatsApp", hint: "QR, codice e accesso" },
  { to: "/database", label: "Area tecnica", hint: "Dati e controlli avanzati" },
  { to: "/settings", label: "Impostazioni", hint: "Profilo e preferenze" },
] as const;

const topbarMetaByPath: Record<string, { eyebrow: string; title: string; subtitle: string }> = {
  "/": {
    eyebrow: "Panoramica",
    title: "Dashboard del salone",
    subtitle: "Vista operativa di agenda, clienti, WhatsApp e andamento della giornata.",
  },
  "/operations": {
    eyebrow: "Operatività",
    title: "Agenda e clienti",
    subtitle: "Appuntamenti, clienti e cronologia in una vista pensata per il lavoro quotidiano.",
  },
  "/activity": {
    eyebrow: "Controlli",
    title: "Storico attività",
    subtitle: "Eventi recenti, audit e diagnostica del sistema.",
  },
  "/connect": {
    eyebrow: "Connessione",
    title: "Collegamento WhatsApp",
    subtitle: "QR, codice e stato del bot in tempo reale.",
  },
  "/database": {
    eyebrow: "Area tecnica",
    title: "Dati e controlli avanzati",
    subtitle: "Strumenti tecnici per ispezione, modifiche e verifiche amministrative.",
  },
  "/settings": {
    eyebrow: "Profilo",
    title: "Impostazioni",
    subtitle: "Preferenze account, notifiche e configurazione del portale.",
  },
};

export function AppShell({ children }: { children: ReactNode }) {
  const location = useLocation();
  const { user, logout } = useAuth();
  const [isMobileNavOpen, setIsMobileNavOpen] = useState(false);
  const canManageBotData = isSystemAdminRole(user?.role);
  const visibleNavItems = navItems.filter((item) => canManageBotData || item.to !== "/database");
  const roleLabel = user?.role === "admin" ? "Amministratore" : "Utente";
  const topbarMeta = topbarMetaByPath[location.pathname] ?? topbarMetaByPath["/"];
  const rawEnvLabel = ((import.meta.env.VITE_ENV_LABEL as string | undefined) ?? (import.meta.env.DEV ? "Locale" : "")).trim();
  const mobileMenuLabel = isMobileNavOpen ? "Chiudi menu" : "Apri menu";

  useEffect(() => {
    setIsMobileNavOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;

    if (isMobileNavOpen) {
      document.body.style.overflow = "hidden";
    }

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isMobileNavOpen]);

  return (
    <div className={`portal-layout ${isMobileNavOpen ? "nav-open" : ""}`}>
      <button
        aria-hidden={!isMobileNavOpen}
        className="mobile-nav-backdrop"
        onClick={() => setIsMobileNavOpen(false)}
        tabIndex={isMobileNavOpen ? 0 : -1}
        type="button"
      />

      <aside className="sidebar" id="portal-sidebar">
        <div className="sidebar-mobile-bar">
          <span className="sidebar-mobile-title">Navigazione</span>
          <button className="link-button sidebar-close" onClick={() => setIsMobileNavOpen(false)} type="button">
            Chiudi
          </button>
        </div>

        <div className="sidebar-header">
          <div className="brand-block">
            <p className="eyebrow">Synkris</p>
            <h1>Control Room</h1>
            <p className="muted">
              Una dashboard React unica per tenere insieme WhatsApp, agenda, clienti e strumenti operativi.
            </p>
          </div>
        </div>

        <nav className="nav-links">
          {visibleNavItems.map((item) => (
            <NavLink end={item.to === "/"} key={item.to} onClick={() => setIsMobileNavOpen(false)} to={item.to}>
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
          <button
            className="ghost-button"
            onClick={() => {
              setIsMobileNavOpen(false);
              logout();
            }}
            type="button"
          >
            Esci
          </button>
        </div>
      </aside>

      <main className="content-area">
        <header className="shell-topbar">
          <div className="shell-topbar-main">
            <button
              aria-controls="portal-sidebar"
              aria-expanded={isMobileNavOpen}
              aria-label={mobileMenuLabel}
              className="mobile-nav-toggle"
              onClick={() => setIsMobileNavOpen((current) => !current)}
              type="button"
            >
              <span className="mobile-nav-toggle-icon" aria-hidden="true">
                <span className="mobile-nav-toggle-line" />
                <span className="mobile-nav-toggle-line" />
                <span className="mobile-nav-toggle-line" />
              </span>
              <span className="mobile-nav-toggle-label">Menu</span>
            </button>

            <div className="shell-topbar-copy">
              <p className="eyebrow">{topbarMeta.eyebrow}</p>
              <h2 className="shell-title">{topbarMeta.title}</h2>
              <p className="muted">{topbarMeta.subtitle}</p>
            </div>
          </div>
          <div className="shell-topbar-meta">
            {rawEnvLabel ? (
              <p className="shell-meta-line">
                Ambiente <strong>{rawEnvLabel}</strong>
              </p>
            ) : null}
            <p className="shell-meta-line">
              Ruolo <strong>{roleLabel}</strong>
            </p>
          </div>
        </header>
        <div className="content-stack">
          <ErrorBoundary>{children}</ErrorBoundary>
        </div>
      </main>
    </div>
  );
}
