import type { BotStatusResponse, ConnectionMode } from "@whatsapp-ai/shared";

function formatAsciiQr(input: string): { block: string; sessionLabel: string | null } {
  const lines = input.split(/\r?\n/u);

  if (lines.length === 0) {
    return { block: "", sessionLabel: null };
  }

  const topBorderIndex = lines.findIndex((line) => line.trimStart().startsWith("┌"));
  const bottomBorderReverseIndex = [...lines].reverse().findIndex((line) => line.trimStart().startsWith("└"));
  const bottomBorderIndex =
    bottomBorderReverseIndex === -1 ? -1 : lines.length - 1 - bottomBorderReverseIndex;

  const framedLines =
    topBorderIndex !== -1 && bottomBorderIndex >= topBorderIndex
      ? lines.slice(topBorderIndex, bottomBorderIndex + 1)
      : lines;

  let sessionLabel: string | null = null;
  if (framedLines[0]?.includes("session-")) {
    sessionLabel = framedLines[0].match(/\b(session-[A-Za-z0-9_-]+)\b/u)?.[1] ?? null;
  }

  const contentLines = framedLines
    .slice(
      framedLines[0]?.trimStart().startsWith("┌") ? 1 : 0,
      framedLines[framedLines.length - 1]?.trimStart().startsWith("└") ? -1 : undefined,
    )
    .map((line) => {
      const glyphs = [...line];
      if (glyphs.length >= 2 && glyphs[0] === "│" && glyphs[glyphs.length - 1] === "│") {
        return glyphs.slice(1, -1).join("");
      }

      return line;
    });

  const width = contentLines.reduce((max, line) => Math.max(max, [...line].length), 0);
  const paddedLines = contentLines.map((line) => line.padEnd(width, " "));

  return {
    block: paddedLines.join("\n"),
    sessionLabel,
  };
}

type ConnectionCardProps = {
  status: BotStatusResponse | null;
  portalUserLabel: string | null;
  onInit: (mode: ConnectionMode) => Promise<void>;
  onRefreshQr: () => Promise<void>;
  onRefreshPairing: () => Promise<void>;
  clientBotDirectory: string;
  clientBotMessage: string | null;
  clientBotProgressMessage: string | null;
  isStartingClientBot: boolean;
  isWaitingForWorker: boolean;
  canStartLocalBot: boolean;
  onChangeClientBotDirectory: (value: string) => void;
  onStartClientBot: () => Promise<void>;
  isBusy: boolean;
};

export function ConnectionCard({
  status,
  portalUserLabel,
  onInit,
  onRefreshQr,
  onRefreshPairing,
  clientBotDirectory,
  clientBotMessage,
  clientBotProgressMessage,
  isStartingClientBot,
  isWaitingForWorker,
  canStartLocalBot,
  onChangeClientBotDirectory,
  onStartClientBot,
  isBusy,
}: ConnectionCardProps) {
  const isManualLaunch = clientBotDirectory.trim().length > 0;
  const launchButtonLabel = isManualLaunch ? "Avvia cartella selezionata" : "Avvia worker locale";
  const asciiQr = status?.qrCodeAscii ? formatAsciiQr(status.qrCodeAscii) : null;

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
        </div>
      </div>

      <p className="muted">
        Il portale mostra QR e pairing code reali ricevuti dal bot-worker. Se la sessione manca, il QR arriva dalla
        pagina WhatsApp aperta dal worker e, se il worker gira headless o server-side, viene ricostruito anche dal QR
        stampato nel terminale come fallback.
      </p>

      <p className="muted">
        Se lasci vuoto, il pulsante sotto avvia solo il <code>bot-worker</code> locale necessario per QR, pairing e
        connessione reale WhatsApp. Il bot vero parte solo quando scegli <strong>Avvia con QR</strong> o{" "}
        <strong>Avvia con codice</strong> dal portale. Se invece inserisci una cartella specifica, viene eseguito{" "}
        <code>npm start</code> solo in quella directory.
      </p>

      <div className="connection-grid">
        <article className="connection-panel">
          <div className="panel-header">
            <h3>QR code</h3>
            <button className="link-button" disabled={isBusy} onClick={() => void onRefreshQr()} type="button">
              Aggiorna
            </button>
          </div>
          {asciiQr?.block ? (
            <div className="qr-ascii-stage">
              <div className="qr-ascii-frame">
                <pre className="qr-ascii-preview">{asciiQr.block}</pre>
              </div>
              <div className="qr-ascii-caption">
                <p className="muted">
                  {portalUserLabel
                    ? `QR ASCII di accesso per ${portalUserLabel}.`
                    : "QR ASCII di accesso della sessione corrente del portale."}
                </p>
                {asciiQr.sessionLabel ? <p className="muted">Sessione worker: {asciiQr.sessionLabel}</p> : null}
              </div>
            </div>
          ) : status?.qrCodeDataUrl ? (
            <p className="muted">
              QR immagine ricevuto dal worker, ma il portale e&apos; impostato per mostrare solo la versione ASCII.
              Premi <strong>Aggiorna</strong> se vuoi forzare il codice testuale.
            </p>
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
          <p className="muted">Utile quando preferisci collegare il dispositivo via codice al posto del QR.</p>
        </article>

        {canStartLocalBot ? (
          <article className="connection-panel">
            <div className="panel-header">
              <h3>Avvio locale</h3>
            </div>

            <label className="editor-label">
              Percorso facoltativo
              <input
                onChange={(event) => onChangeClientBotDirectory(event.target.value)}
                placeholder="Solo locale o assistenza. Sul server puoi lasciare vuoto."
                value={clientBotDirectory}
              />
            </label>

            <p className="muted">
              Lascia vuoto per avviare solo il worker locale del progetto. Il login WhatsApp parte poi dai pulsanti del
              portale. Inserisci un percorso solo quando vuoi lanciare manualmente un altro bot con <code>npm start</code>.
            </p>

            {clientBotMessage ? <p className="success-banner">{clientBotMessage}</p> : null}
            {clientBotProgressMessage ? <p className="warning-banner">{clientBotProgressMessage}</p> : null}

            <div className="action-row">
              <button
                disabled={isBusy || isStartingClientBot || isWaitingForWorker}
                onClick={() => void onStartClientBot()}
                type="button"
              >
                {isStartingClientBot ? "Avvio..." : isWaitingForWorker ? "Attendo worker..." : launchButtonLabel}
              </button>
            </div>
          </article>
        ) : null}
      </div>
    </section>
  );
}
