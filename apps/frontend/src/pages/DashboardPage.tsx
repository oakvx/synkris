import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

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
        <p className="eyebrow">Centro operativo</p>
        <h2>Controllo bot, sessione WhatsApp e database dallo stesso gestionale.</h2>
        <p className="muted">
          Da qui puoi vedere se il bot e&apos; davvero connesso, aprire il flusso QR reale e modificare i dati del database
          senza passare da file sparsi o terminali secondari.
        </p>
      </section>

      {error ? <p className="error-banner">{error}</p> : null}

      <BotStatusCard status={status} />

      <section className="card">
        <div className="card-heading">
          <div>
            <p className="eyebrow">Azioni rapide</p>
            <h2>Lavora in modo piu pratico</h2>
          </div>
        </div>

        <div className="timeline-grid">
          <article className="action-panel">
            <strong>Connessione WhatsApp</strong>
            <p>Apri il QR reale, controlla pairing code e forza una nuova inizializzazione del worker.</p>
            <Link className="inline-action" to="/connect">
              Vai alla connessione
            </Link>
          </article>
          <article className="action-panel">
            <strong>Database bot</strong>
            <p>Modifica record e tabelle operative del bot direttamente dal portale in formato JSON strutturato.</p>
            <Link className="inline-action" to="/database">
              Apri editor DB
            </Link>
          </article>
          <article className="action-panel">
            <strong>Preferenze account</strong>
            <p>Aggiorna modalita preferita, numero telefono e dati base usati dal flusso di collegamento.</p>
            <Link className="inline-action" to="/settings">
              Apri impostazioni
            </Link>
          </article>
        </div>
      </section>
    </div>
  );
}
