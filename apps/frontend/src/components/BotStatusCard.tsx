import type { BotStatusResponse } from "@whatsapp-ai/shared";

const labels: Record<BotStatusResponse["status"], string> = {
  disconnected: "Disconnesso",
  waiting_qr: "In attesa QR",
  waiting_pairing: "In attesa pairing code",
  connecting: "Connessione in corso",
  connected: "Connesso",
  error: "Errore",
};

type BotStatusCardProps = {
  status: BotStatusResponse | null;
  onDisconnect?: () => Promise<void>;
  isBusy?: boolean;
};

function persistenceLabel(status: BotStatusResponse) {
  if (status.sessionPersisted) {
    return "Si, sessione salvata sul server";
  }

  if (status.status === "connected") {
    return "Connessione attiva, persistenza non ancora confermata";
  }

  if (status.status === "connecting" || status.status === "waiting_qr" || status.status === "waiting_pairing") {
    return "Il worker sta ancora preparando o verificando la sessione";
  }

  return "No, serve un nuovo accesso";
}

function statusDescription(status: BotStatusResponse) {
  if (status.isStale) {
    return "Sto mostrando uno snapshot salvato: il worker non sta fornendo stato fresco in questo momento.";
  }

  if (status.status === "connected") {
    return status.sessionPersisted
      ? "Bot attivo, sessione WhatsApp valida e gia' confermata sul server."
      : "Bot attivo e collegato adesso. La persistenza della sessione non e' ancora stata confermata dal worker.";
  }

  if (status.status === "waiting_qr") {
    return "Sessione assente o scaduta: scansiona il QR reale mostrato dal worker.";
  }

  if (status.status === "waiting_pairing") {
    return "Sessione assente o scaduta: usa il codice di pairing reale.";
  }

  if (status.status === "connecting") {
    return "Il worker sta aprendo la pagina WhatsApp e verificando la sessione.";
  }

  if (status.status === "error") {
    return "Il worker ha incontrato un errore. Controlla il messaggio sotto e riprova.";
  }

  return "Bot fermo o non inizializzato.";
}

export function BotStatusCard({ status, onDisconnect, isBusy = false }: BotStatusCardProps) {
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
          <dt>Persistenza sessione</dt>
          <dd>{persistenceLabel(status)}</dd>
        </div>
        <div>
          <dt>Aggiornato</dt>
          <dd>{new Date(status.updatedAt).toLocaleString("it-IT")}</dd>
        </div>
      </dl>

      <p className="muted">{statusDescription(status)}</p>

      {status.isStale ? <p className="warning-banner">{status.staleReason ?? "Stato non aggiornato in tempo reale."}</p> : null}
      {status.lastError ? <p className="error-banner">{status.lastError}</p> : null}

      {onDisconnect ? (
        <div className="action-row status-actions">
          <button className="danger-button" disabled={isBusy} onClick={() => void onDisconnect()} type="button">
            {isBusy ? "Disconnessione..." : "Disconnetti bot"}
          </button>
          <span className="status-note">
            Chiude la sessione corrente e richiedera' un nuovo QR o un nuovo codice di pairing.
          </span>
        </div>
      ) : null}
    </section>
  );
}
