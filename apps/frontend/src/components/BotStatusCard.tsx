import type { BotStatusResponse } from "@whatsapp-ai/shared";

const labels: Record<BotStatusResponse["status"], string> = {
  disconnected: "Non collegato",
  waiting_qr: "In attesa del QR",
  waiting_pairing: "In attesa del codice",
  connecting: "Collegamento in corso",
  connected: "Collegato",
  error: "Errore",
};

type BotStatusCardProps = {
  status: BotStatusResponse | null;
  onDisconnect?: () => Promise<void>;
  isBusy?: boolean;
};

function savedAccessLabel(status: BotStatusResponse) {
  if (status.sessionPersisted) {
    return "Sì, non serve rifare l'accesso ogni volta";
  }

  if (status.status === "connected") {
    return "Il collegamento è attivo, ma il salvataggio non è ancora confermato";
  }

  if (status.status === "connecting" || status.status === "waiting_qr" || status.status === "waiting_pairing") {
    return "Il sistema sta ancora preparando il collegamento";
  }

  return "No, potrebbe servire un nuovo accesso";
}

function statusDescription(status: BotStatusResponse) {
  if (status.isStale) {
    return "Ti sto mostrando l'ultimo aggiornamento salvato. Le informazioni in tempo reale non sono disponibili in questo momento.";
  }

  if (status.status === "connected") {
    return status.sessionPersisted
      ? "WhatsApp è collegato e il collegamento risulta salvato."
      : "WhatsApp è collegato, ma il salvataggio automatico non è ancora confermato.";
  }

  if (status.status === "waiting_qr") {
    return "Per continuare, apri il QR e scansionalo con il telefono.";
  }

  if (status.status === "waiting_pairing") {
    return "Per continuare, usa il codice mostrato nella pagina.";
  }

  if (status.status === "connecting") {
    return "Il sistema sta provando a collegare WhatsApp.";
  }

  if (status.status === "error") {
    return "C'è stato un problema. Controlla il messaggio qui sotto e riprova.";
  }

  return "WhatsApp non è ancora collegato.";
}

export function BotStatusCard({ status, onDisconnect, isBusy = false }: BotStatusCardProps) {
  if (!status) {
    return (
      <section className="card">
        <h2>Stato WhatsApp</h2>
        <p className="muted">Per ora non ci sono informazioni disponibili. Apri la pagina di collegamento per iniziare.</p>
      </section>
    );
  }

  return (
    <section className="card status-card">
      <div className="status-header">
        <div>
          <p className="eyebrow">Collegamento</p>
          <h2>WhatsApp</h2>
        </div>
        <span className={`status-pill status-${status.status}`}>{labels[status.status]}</span>
      </div>

      <dl className="details-grid">
        <div>
          <dt>Telefono</dt>
          <dd>{status.phoneNumber ?? "Non disponibile"}</dd>
        </div>
        <div>
          <dt>Accesso salvato</dt>
          <dd>{savedAccessLabel(status)}</dd>
        </div>
        <div>
          <dt>Ultimo controllo</dt>
          <dd>{new Date(status.updatedAt).toLocaleString("it-IT")}</dd>
        </div>
        <div>
          <dt>Servizio</dt>
          <dd>{status.provider}</dd>
        </div>
      </dl>

      <p className="muted">{statusDescription(status)}</p>

      {status.isStale ? <p className="warning-banner">{status.staleReason ?? "Le informazioni non sono aggiornate in tempo reale."}</p> : null}
      {status.lastError ? <p className="error-banner">{status.lastError}</p> : null}

      {onDisconnect ? (
        <div className="action-row status-actions">
          <button className="danger-button" disabled={isBusy} onClick={() => void onDisconnect()} type="button">
            {isBusy ? "Sto scollegando..." : "Scollega WhatsApp"}
          </button>
          <span className="status-note">Chiude il collegamento attuale e ti permette di rifarlo da capo.</span>
        </div>
      ) : null}
    </section>
  );
}
