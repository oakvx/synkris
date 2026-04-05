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
          <dd>{status.sessionPersisted ? "Si, sessione attiva sul server" : "No, serve un nuovo accesso"}</dd>
        </div>
        <div>
          <dt>Aggiornato</dt>
          <dd>{new Date(status.updatedAt).toLocaleString("it-IT")}</dd>
        </div>
      </dl>

      <p className="muted">
        {status.status === "connected"
          ? "Bot attivo e sessione WhatsApp valida."
          : status.status === "waiting_qr"
            ? "Sessione assente o scaduta: scansiona il QR reale mostrato dal worker."
            : status.status === "waiting_pairing"
              ? "Sessione assente o scaduta: usa il codice di pairing reale."
              : status.status === "connecting"
                ? "Il worker sta aprendo la pagina WhatsApp e verificando la sessione."
                : status.status === "error"
                  ? "Il worker ha incontrato un errore. Controlla il messaggio sotto e riprova."
                  : "Bot fermo o non inizializzato."}
      </p>

      {status.lastError ? <p className="error-banner">{status.lastError}</p> : null}
    </section>
  );
}
