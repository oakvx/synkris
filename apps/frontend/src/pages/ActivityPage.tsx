import { useEffect, useState } from "react";

import {
  canViewAuditLog,
  type AuditEvent,
  type BotDiagnosticsResponse,
  type BotStatusResponse,
  type BotEvent,
} from "@whatsapp-ai/shared";

import { useAuth } from "../auth/useAuth";
import { BotStatusCard } from "../components/BotStatusCard";
import { apiClient, getErrorMessage } from "../lib/api";

function formatDateTime(value: string) {
  return new Date(value).toLocaleString("it-IT");
}

function eventLevelLabel(level: BotEvent["level"] | AuditEvent["category"]) {
  return String(level).replace(/_/g, " ");
}

function statusLabel(status: BotStatusResponse["status"] | undefined) {
  switch (status) {
    case "connected":
      return "Collegato";
    case "waiting_qr":
      return "In attesa del QR";
    case "waiting_pairing":
      return "In attesa del codice";
    case "connecting":
      return "Collegamento in corso";
    case "error":
      return "C'è un problema";
    case "disconnected":
      return "Non collegato";
    default:
      return "Nessun dato";
  }
}

function stringifyDetails(value: unknown) {
  if (!value) {
    return null;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function ActivityPage() {
  const { token, user } = useAuth();
  const [diagnostics, setDiagnostics] = useState<BotDiagnosticsResponse | null>(null);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const canSeeAudit = canViewAuditLog(user?.role);

  useEffect(() => {
    let active = true;

    async function loadActivity() {
      if (!token) {
        return;
      }

      setIsLoading(true);
      setError(null);

      try {
        const [nextDiagnostics, nextAudit] = await Promise.all([
          apiClient.getBotDiagnostics(token, 50),
          canSeeAudit ? apiClient.getAuditEvents(token, 80) : Promise.resolve({ events: [] }),
        ]);

        if (!active) {
          return;
        }

        setDiagnostics(nextDiagnostics);
        setAuditEvents(nextAudit.events);
      } catch (loadError) {
        if (active) {
          setError(getErrorMessage(loadError, "Non riesco a caricare lo storico."));
        }
      } finally {
        if (active) {
          setIsLoading(false);
        }
      }
    }

    void loadActivity();

    return () => {
      active = false;
    };
  }, [canSeeAudit, token]);

  const botEvents = diagnostics?.events ?? [];

  return (
    <div className="page-stack">
      <section className="hero-card">
        <p className="eyebrow">Storico</p>
        <h2>Qui trovi cosa è successo di recente.</h2>
        <p className="muted">
          Puoi controllare gli ultimi cambi di stato di WhatsApp e, se sei amministratore, anche le azioni importanti
          fatte nel portale.
        </p>

        <div className="hero-metrics">
          <article className="metric-card">
            <span className="metric-label">Eventi WhatsApp</span>
            <strong>{botEvents.length}</strong>
            <p>Cambi di stato, problemi e nuovi avvii.</p>
          </article>
          <article className="metric-card">
            <span className="metric-label">Azioni importanti</span>
            <strong>{auditEvents.length}</strong>
            <p>Accessi, modifiche e comandi lanciati dal portale.</p>
          </article>
          <article className="metric-card">
            <span className="metric-label">Situazione adesso</span>
            <strong>{statusLabel(diagnostics?.currentStatus?.status)}</strong>
            <p>Lo stato più recente del collegamento.</p>
          </article>
        </div>
      </section>

      {error ? <p className="error-banner">{error}</p> : null}

      {diagnostics?.currentStatus ? <BotStatusCard status={diagnostics.currentStatus} /> : null}

      <section className="card">
        <div className="card-heading">
          <div>
            <p className="eyebrow">WhatsApp</p>
            <h3>Ultimi aggiornamenti</h3>
          </div>
        </div>

        {isLoading ? (
          <div className="db-empty">Sto caricando gli aggiornamenti...</div>
        ) : botEvents.length === 0 ? (
          <div className="db-empty">Per ora non ci sono aggiornamenti da mostrare.</div>
        ) : (
          <div className="event-list">
            {botEvents.map((event) => (
              <article className={`event-item level-${event.level}`} key={event.id}>
                <div className="event-item-head">
                  <strong>{event.message}</strong>
                  <span className="field-badge">{eventLevelLabel(event.level)}</span>
                </div>
                <p className="muted">
                  {formatDateTime(event.createdAt)} - codice {event.code}
                  {event.status ? ` - stato ${event.status}` : ""}
                </p>
                {event.details ? <pre className="event-pre">{stringifyDetails(event.details)}</pre> : null}
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-heading">
          <div>
            <p className="eyebrow">Azioni del portale</p>
            <h3>Storico completo</h3>
          </div>
        </div>

        {!canSeeAudit ? (
          <div className="db-empty">Questo storico completo è visibile solo all'amministratore.</div>
        ) : isLoading ? (
          <div className="db-empty">Sto caricando lo storico completo...</div>
        ) : auditEvents.length === 0 ? (
          <div className="db-empty">Per ora non ci sono azioni registrate.</div>
        ) : (
          <div className="event-list">
            {auditEvents.map((event) => (
              <article className="event-item" key={event.id}>
                <div className="event-item-head">
                  <strong>{event.summary}</strong>
                  <span className="field-badge">{eventLevelLabel(event.category)}</span>
                </div>
                <p className="muted">
                  {formatDateTime(event.createdAt)} - {event.actorEmail ?? "azione interna"} - {event.action}
                </p>
                {event.metadata ? <pre className="event-pre">{stringifyDetails(event.metadata)}</pre> : null}
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
