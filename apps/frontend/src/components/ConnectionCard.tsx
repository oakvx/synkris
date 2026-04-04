import type { BotStatusResponse, ConnectionMode } from "@whatsapp-ai/shared";

type ConnectionCardProps = {
  status: BotStatusResponse | null;
  onInit: (mode: ConnectionMode) => Promise<void>;
  onRefreshQr: () => Promise<void>;
  onRefreshPairing: () => Promise<void>;
  onDisconnect: () => Promise<void>;
  isBusy: boolean;
};

export function ConnectionCard({
  status,
  onInit,
  onRefreshQr,
  onRefreshPairing,
  onDisconnect,
  isBusy,
}: ConnectionCardProps) {
  return (
    <section className="card connect-card">
      <div className="card-heading">
        <div>
          <p className="eyebrow">Connessione lato server</p>
          <h2>Collega il tuo account WhatsApp</h2>
        </div>
        <div className="action-row">
          <button disabled={isBusy} onClick={() => void onInit("qr")} type="button">
            Avvia con QR
          </button>
          <button className="ghost-button" disabled={isBusy} onClick={() => void onInit("pairing")} type="button">
            Avvia con codice
          </button>
          <button className="danger-button" disabled={isBusy} onClick={() => void onDisconnect()} type="button">
            Disconnetti
          </button>
        </div>
      </div>

      <p className="muted">
        Il browser visualizza solo QR o pairing code ricevuti dall’API. La sessione reale resta sul server e viene
        persistita nel volume del bot-worker.
      </p>

      <div className="connection-grid">
        <article className="connection-panel">
          <div className="panel-header">
            <h3>QR code</h3>
            <button className="link-button" disabled={isBusy} onClick={() => void onRefreshQr()} type="button">
              Aggiorna
            </button>
          </div>
          {status?.qrCodeDataUrl ? (
            <img alt="QR code di connessione" className="qr-preview" src={status.qrCodeDataUrl} />
          ) : (
            <p className="muted">Nessun QR attivo al momento.</p>
          )}
        </article>

        <article className="connection-panel">
          <div className="panel-header">
            <h3>Pairing code</h3>
            <button className="link-button" disabled={isBusy} onClick={() => void onRefreshPairing()} type="button">
              Aggiorna
            </button>
          </div>
          <div className="pairing-box">{status?.pairingCode ?? "---- ----"}</div>
          <p className="muted">
            Utile quando preferisci collegare il dispositivo via codice al posto del QR.
          </p>
        </article>
      </div>
    </section>
  );
}
