import type { BotStatusResponse, ConnectionMode } from "@whatsapp-ai/shared";

function formatAsciiQr(input: string): { block: string; sessionLabel: string | null } {
  const lines = input.split(/\r?\n/u);

  if (lines.length === 0) {
    return { block: "", sessionLabel: null };
  }

  const topBorderIndex = lines.findIndex((line) => line.trimStart().startsWith("â”Œ"));
  const bottomBorderReverseIndex = [...lines].reverse().findIndex((line) => line.trimStart().startsWith("â””"));
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
      framedLines[0]?.trimStart().startsWith("â”Œ") ? 1 : 0,
      framedLines[framedLines.length - 1]?.trimStart().startsWith("â””") ? -1 : undefined,
    )
    .map((line) => {
      const glyphs = [...line];
      if (glyphs.length >= 2 && glyphs[0] === "â”‚" && glyphs[glyphs.length - 1] === "â”‚") {
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
  const launchButtonLabel = isManualLaunch ? "Avvia la cartella scelta" : "Avvia il servizio locale";
  const asciiQr = status?.qrCodeAscii ? formatAsciiQr(status.qrCodeAscii) : null;

  return (
    <section className="card connect-card">
      <div className="card-heading">
        <div>
          <p className="eyebrow">Collegamento WhatsApp</p>
          <h2>Collega il telefono in pochi passaggi</h2>
        </div>
        <div className="action-row">
          <button disabled={isBusy} onClick={() => void onInit("qr")} type="button">
            Usa il QR
          </button>
          <button className="ghost-button" disabled={isBusy} onClick={() => void onInit("pairing")} type="button">
            Usa il codice
          </button>
        </div>
      </div>

      <p className="muted">
        Qui vedi il QR o il codice reale da usare per collegare WhatsApp. In pratica, è la pagina da aprire quando devi
        fare o rifare l'accesso del telefono.
      </p>

      <div className="connection-grid">
        <article className="connection-panel">
          <div className="panel-header">
            <h3>QR da scansionare</h3>
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
                    ? `QR pronto per ${portalUserLabel}.`
                    : "QR pronto per il collegamento attuale."}
                </p>
                {asciiQr.sessionLabel ? <p className="muted">Riferimento interno: {asciiQr.sessionLabel}</p> : null}
              </div>
            </div>
          ) : status?.qrCodeDataUrl ? (
            <p className="muted">
              Il QR è disponibile, ma qui viene mostrata la versione testuale. Premi <strong>Aggiorna</strong> se vuoi
              riprovare a vederlo.
            </p>
          ) : (
            <p className="muted">In questo momento non c'è nessun QR da mostrare.</p>
          )}
        </article>

        <article className="connection-panel">
          <div className="panel-header">
            <h3>Codice di accesso</h3>
            <button className="link-button" disabled={isBusy} onClick={() => void onRefreshPairing()} type="button">
              Aggiorna
            </button>
          </div>
          <div className="pairing-box">{status?.pairingCode ?? "---- ----"}</div>
          <p className="muted">Puoi usare questo codice se preferisci non scansionare il QR.</p>
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
                placeholder="Puoi lasciarlo vuoto"
                value={clientBotDirectory}
              />
            </label>

            <p className="muted">
              Se lasci vuoto, il portale avvia solo il servizio necessario per mostrare QR e codice. Compila il campo
              solo se devi far partire manualmente una cartella specifica.
            </p>

            {clientBotMessage ? <p className="success-banner">{clientBotMessage}</p> : null}
            {clientBotProgressMessage ? <p className="warning-banner">{clientBotProgressMessage}</p> : null}

            <div className="action-row">
              <button
                disabled={isBusy || isStartingClientBot || isWaitingForWorker}
                onClick={() => void onStartClientBot()}
                type="button"
              >
                {isStartingClientBot ? "Avvio..." : isWaitingForWorker ? "Sto aspettando..." : launchButtonLabel}
              </button>
            </div>
          </article>
        ) : null}
      </div>
    </section>
  );
}
