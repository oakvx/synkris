import { useEffect, useState } from "react";

import type { BotStatusResponse } from "@whatsapp-ai/shared";

import { useAuth } from "../auth/AuthContext";
import { BotStatusCard } from "../components/BotStatusCard";
import { apiClient } from "../lib/api";

export function DashboardPage() {
  const { token } = useAuth();
  const [status, setStatus] = useState<BotStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function loadStatus() {
      if (!token) {
        return;
      }

      try {
        const nextStatus = await apiClient.getBotStatus(token);
        if (active) {
          setStatus(nextStatus);
        }
      } catch (loadError) {
        if (active) {
          setError(loadError instanceof Error ? loadError.message : "Impossibile leggere lo stato del bot.");
        }
      }
    }

    void loadStatus();
    return () => {
      active = false;
    };
  }, [token]);

  return (
    <div className="page-stack">
      <section className="hero-card">
        <p className="eyebrow">Architettura target</p>
        <h2>Frontend statico, API centrale, bot-worker separato, sessioni persistenti lato server.</h2>
        <p className="muted">
          Il portale mostra lo stato del tuo bot e invia richieste HTTP verso il backend. Il browser non salva mai la
          sessione WhatsApp.
        </p>
      </section>

      {error ? <p className="error-banner">{error}</p> : null}

      <BotStatusCard status={status} />

      <section className="card">
        <h2>Flusso operativo</h2>
        <div className="timeline-grid">
          <article>
            <strong>1. Portale utente</strong>
            <p>Login, dashboard, stato istanza e impostazioni base.</p>
          </article>
          <article>
            <strong>2. Backend API</strong>
            <p>Auth, validazione input, CORS e coordinamento dei servizi interni.</p>
          </article>
          <article>
            <strong>3. Bot worker</strong>
            <p>Generazione QR/pairing, persistenza sessioni su volume Docker e sync dello stato.</p>
          </article>
        </div>
      </section>
    </div>
  );
}
