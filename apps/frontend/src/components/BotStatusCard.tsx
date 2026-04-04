import type { BotStatusResponse } from "@whatsapp-ai/shared";

const labels: Record<BotStatusResponse["status"], string> = {
  disconnected: "Disconnesso",
  waiting_qr: "In attesa QR",
  waiting_pairing: "In attesa pairing code",
  connecting: "Connessione in corso",
  connected: "Connesso",
  error: "Errore",
};

export function BotStatusCard({ status }: { status: BotStatusResponse | null }) {
  if (!status) {
    return (
      <section className="card">
        <h2>Stato bot</h2>
        <p className="muted">Nessuno stato disponibile ancora. Avvia una connessione dalla pagina dedicata.</p>
      </section>
    );
  }

  return (
    <section className="card status-card">
      <div className="status-header">
        <div>
          <p className="eyebrow">Istanza utente</p>
          <h2>Bot WhatsApp</h2>
        </div>
        <span className={`status-pill status-${status.status}`}>{labels[status.status]}</span>
      </div>

      <dl className="details-grid">
        <div>
          <dt>Provider</dt>
          <dd>{status.provider}</dd>
        </div>
        <div>
          <dt>Telefono</dt>
          <dd>{status.phoneNumber ?? "Non disponibile"}</dd>
        </div>
        <div>
          <dt>Sessione persistita</dt>
          <dd>{status.sessionPersisted ? "Sì" : "Non ancora"}</dd>
        </div>
        <div>
          <dt>Aggiornato</dt>
          <dd>{new Date(status.updatedAt).toLocaleString("it-IT")}</dd>
        </div>
      </dl>

      {status.lastError ? <p className="error-banner">{status.lastError}</p> : null}
    </section>
  );
}
