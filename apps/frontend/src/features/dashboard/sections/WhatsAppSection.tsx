import { Link } from "react-router-dom";

import type { BotEvent, BotStatusResponse } from "@whatsapp-ai/shared";

import { BotStatusCard } from "../../../components/BotStatusCard";
import { botStatusLabel, connectionModeLabel, formatDateTime } from "../dashboardView";

type WhatsAppSectionProps = {
  botEvents: BotEvent[];
  botStatus: BotStatusResponse | null;
  botStatusError: string | null;
  isDisconnecting: boolean;
  notificationsEnabled: boolean;
  onDisconnect: () => Promise<void>;
  preferredConnectionMode: BotStatusResponse["connectionMode"] | "qr" | "pairing" | null | undefined;
};

export function WhatsAppSection({
  botEvents,
  botStatus,
  botStatusError,
  isDisconnecting,
  notificationsEnabled,
  onDisconnect,
  preferredConnectionMode,
}: WhatsAppSectionProps) {
  return (
    <div className="dashboard-panel-grid">
      {botStatusError ? <p className="warning-banner">{botStatusError}</p> : null}
      <BotStatusCard isBusy={isDisconnecting} onDisconnect={onDisconnect} status={botStatus} />

      <section className="card">
        <div className="card-heading">
          <div>
            <p className="eyebrow">Stato operativo</p>
            <h3>Contesto del collegamento</h3>
          </div>
        </div>

        <div className="dashboard-focus-grid">
          <article className="dashboard-focus-card">
            <span className="metric-label">Modalita preferita</span>
            <strong>{connectionModeLabel(preferredConnectionMode)}</strong>
            <p>La preferenza salvata nelle impostazioni del portale.</p>
          </article>
          <article className="dashboard-focus-card">
            <span className="metric-label">Ultimo aggiornamento</span>
            <strong>{botStatus ? formatDateTime(botStatus.updatedAt) : "Nessun dato"}</strong>
            <p>{botStatus?.isStale ? "Sto mostrando l'ultimo stato salvato." : "Dati recenti dal worker."}</p>
          </article>
          <article className="dashboard-focus-card">
            <span className="metric-label">Notifiche</span>
            <strong>{notificationsEnabled ? "Attive" : "Spente"}</strong>
            <p>Ti ricorda se il portale puo mostrarti avvisi e aggiornamenti.</p>
          </article>
        </div>
      </section>

      <section className="card">
        <div className="card-heading">
          <div>
            <p className="eyebrow">Diagnostica recente</p>
            <h3>Eventi del bot</h3>
          </div>
          <Link className="inline-action dashboard-inline-link" to="/connect">
            Apri collegamento
          </Link>
        </div>

        {botEvents.length === 0 ? (
          <div className="db-empty">Per ora non risultano eventi da mostrare.</div>
        ) : (
          <div className="event-list">
            {botEvents.slice(0, 10).map((event) => (
              <article className={`event-item level-${event.level}`} key={event.id}>
                <div className="event-item-head">
                  <strong>{event.message}</strong>
                  <span className="field-badge">{event.code}</span>
                </div>
                <p className="muted">
                  {formatDateTime(event.createdAt)} · stato {botStatusLabel(event.status ?? undefined)}
                </p>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
