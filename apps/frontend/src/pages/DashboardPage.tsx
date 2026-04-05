import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { isSystemAdminRole, type BotStatusResponse } from "@whatsapp-ai/shared";

import { useAuth } from "../auth/useAuth";
import { BotStatusCard } from "../components/BotStatusCard";
import { apiClient, getErrorMessage } from "../lib/api";

const statusLabels: Record<NonNullable<BotStatusResponse["status"]>, string> = {
  disconnected: "Disconnesso",
  waiting_qr: "In attesa QR",
  waiting_pairing: "In attesa codice",
  connecting: "Connessione in corso",
  connected: "Operativo",
  error: "Errore",
};

export function DashboardPage() {
  const { token, user } = useAuth();
  const [status, setStatus] = useState<BotStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const canManageBotData = isSystemAdminRole(user?.role);

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
          setError(getErrorMessage(loadError, "Impossibile leggere lo stato del bot."));
        }
      }
    }

    void loadStatus();
    return () => {
      active = false;
    };
  }, [token]);

  async function handleDisconnect() {
    if (!token) {
      return;
    }

    setIsBusy(true);
    setError(null);

    try {
      const nextStatus = await apiClient.disconnectBot(token);
      setStatus(nextStatus);
    } catch (actionError) {
      setError(getErrorMessage(actionError, "Disconnessione non riuscita."));
    } finally {
      setIsBusy(false);
    }
  }

  const statusLabel = status ? statusLabels[status.status] : "Da inizializzare";
  const connectionModeLabel =
    status?.connectionMode === "pairing" ? "Codice di pairing" : status?.connectionMode === "qr" ? "QR code" : "Da scegliere";
  const lastUpdateLabel = status ? new Date(status.updatedAt).toLocaleString("it-IT") : "Nessun dato ancora";

  return (
    <div className="page-stack">
      <section className="hero-card hero-split">
        <div>
          <p className="eyebrow">Centro operativo</p>
          <h2>Controllo bot, sessione WhatsApp e database dallo stesso gestionale.</h2>
          <p className="muted">
            Da qui puoi vedere se il bot e&apos; davvero connesso, aprire il flusso QR reale e modificare i dati del
            database senza passare da file sparsi o terminali secondari.
          </p>
        </div>

        <div className="hero-metrics">
          <article className="metric-card">
            <span className="metric-label">Stato attuale</span>
            <strong>{statusLabel}</strong>
            <p>{status?.status === "connected" ? "Il bot risponde con una sessione valida." : "Serve attenzione o una nuova inizializzazione."}</p>
          </article>
          <article className="metric-card">
            <span className="metric-label">Modalita attiva</span>
            <strong>{connectionModeLabel}</strong>
            <p>Usa il metodo di collegamento piu comodo per il dispositivo che stai configurando.</p>
          </article>
          <article className="metric-card">
            <span className="metric-label">Ultimo aggiornamento</span>
            <strong>{lastUpdateLabel}</strong>
            <p>Ti aiuta a capire se il worker sta ancora producendo stato fresco.</p>
          </article>
        </div>
      </section>

      {error ? <p className="error-banner">{error}</p> : null}

      <BotStatusCard isBusy={isBusy} onDisconnect={handleDisconnect} status={status} />

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
            <p>Apri il QR reale, controlla il codice di pairing e forza una nuova inizializzazione del worker.</p>
            <Link className="inline-action" to="/connect">
              Vai alla connessione
            </Link>
          </article>
          {canManageBotData ? (
            <article className="action-panel">
              <strong>Database bot</strong>
              <p>Modifica record e tabelle operative del bot direttamente dal portale con campi guidati.</p>
              <Link className="inline-action" to="/database">
                Apri editor DB
              </Link>
            </article>
          ) : null}
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
