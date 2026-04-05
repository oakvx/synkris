import { useEffect, useRef, useState } from "react";

import { isSystemAdminRole, type BotStatusResponse, type ConnectionMode } from "@whatsapp-ai/shared";

import { useAuth } from "../auth/useAuth";
import { BotStatusCard } from "../components/BotStatusCard";
import { ConnectionCard } from "../components/ConnectionCard";
import { apiClient, getErrorMessage, isRetryableError } from "../lib/api";

const WORKER_BOOT_MAX_ATTEMPTS = 25;
const WORKER_BOOT_INTERVAL_MS = 4000;
const WORKER_BACKGROUND_POLL_INTERVAL_MS = 8000;
const QR_BIND_MAX_ATTEMPTS = 60;
const QR_BIND_INTERVAL_MS = 1000;

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function ConnectWhatsAppPage() {
  const { token, user } = useAuth();
  const portalUserLabel = user?.displayName ?? user?.email ?? null;
  const canStartLocalBot = isSystemAdminRole(user?.role);
  const [status, setStatus] = useState<BotStatusResponse | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [isStartingClientBot, setIsStartingClientBot] = useState(false);
  const [isWaitingForWorker, setIsWaitingForWorker] = useState(false);
  const [clientBotMessage, setClientBotMessage] = useState<string | null>(null);
  const [clientBotProgressMessage, setClientBotProgressMessage] = useState<string | null>(null);
  const [clientBotDirectory, setClientBotDirectory] = useState("");
  const [pageError, setPageError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [pollingError, setPollingError] = useState<string | null>(null);
  const workerBootstrapRunRef = useRef(0);
  const qrBindingRunRef = useRef(0);

  const clientBotDirectoryStorageKey = user
    ? `whatsapp-ai.client-bot-directory.${user.id}`
    : "whatsapp-ai.client-bot-directory";

  useEffect(() => {
    setClientBotDirectory(localStorage.getItem(clientBotDirectoryStorageKey) ?? "");
  }, [clientBotDirectoryStorageKey]);

  useEffect(() => {
    localStorage.setItem(clientBotDirectoryStorageKey, clientBotDirectory);
  }, [clientBotDirectory, clientBotDirectoryStorageKey]);

  useEffect(() => {
    return () => {
      workerBootstrapRunRef.current += 1;
      qrBindingRunRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!actionMessage) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setActionMessage(null);
    }, 3000);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [actionMessage]);

  function hasVisibleQr(nextStatus: BotStatusResponse | null): boolean {
    return Boolean(nextStatus?.qrCodeAscii || nextStatus?.qrCodeDataUrl);
  }

  function appendClientBotMessage(message: string) {
    setClientBotMessage((current) => (current ? `${current} ${message}` : message));
  }

  function buildWorkerReadyMessage(nextStatus: BotStatusResponse): string {
    if (nextStatus.status === "waiting_pairing" && nextStatus.pairingCode) {
      return "Il servizio è pronto. Puoi continuare con il codice già visibile.";
    }

    if (nextStatus.status === "connected") {
      return "Il servizio è pronto e WhatsApp risulta già collegato.";
    }

    if (nextStatus.status === "waiting_qr") {
      return "Il servizio è pronto. Il QR è già disponibile in questa pagina.";
    }

    if (nextStatus.status === "connecting") {
      return "Il servizio è pronto. Completa il collegamento con QR o codice.";
    }

    return "Il servizio è pronto. Ora puoi iniziare il collegamento da questa pagina.";
  }

  async function tryFinalizeWorkerBootstrap(runId: number, options: { background?: boolean } = {}) {
    if (!token) {
      return false;
    }

    try {
      const nextStatus = await apiClient.getBotStatus(token);
      if (workerBootstrapRunRef.current !== runId) {
        return true;
      }

      setStatus(nextStatus);
      if (nextStatus.isStale) {
        return false;
      }

      setIsWaitingForWorker(false);
      setClientBotProgressMessage(null);
      setPollingError(null);
      appendClientBotMessage(buildWorkerReadyMessage(nextStatus));
      return true;
    } catch (error) {
      if (workerBootstrapRunRef.current !== runId) {
        return true;
      }

      if (!options.background) {
        const message = getErrorMessage(error, "Sto aspettando che il servizio sia pronto.");
        setClientBotProgressMessage(`${message} Riprovo automaticamente tra pochi secondi.`);
      }

      return false;
    }
  }

  async function continueWaitingForWorkerInBackground(runId: number) {
    while (workerBootstrapRunRef.current === runId) {
      const completed = await tryFinalizeWorkerBootstrap(runId, { background: true });
      if (completed) {
        return;
      }

      await wait(WORKER_BACKGROUND_POLL_INTERVAL_MS);
    }
  }

  async function loadStatus(options: { background?: boolean } = {}) {
    if (!token) {
      return;
    }

    try {
      const nextStatus = await apiClient.getBotStatus(token);
      setStatus(nextStatus);
      if (options.background) {
        setPollingError(null);
      } else {
        setPageError(null);
      }
    } catch (loadError) {
      const fallback = options.background
        ? "Aggiornamento automatico non riuscito."
        : "Impossibile leggere lo stato corrente.";
      const message = getErrorMessage(loadError, fallback);
      if (options.background) {
        setPollingError(
          isRetryableError(loadError)
            ? `${message} Tengo visibile l'ultimo stato noto e riprovo automaticamente.`
            : message,
        );
      } else {
        setPageError(message);
      }
    }
  }

  useEffect(() => {
    let timerId: number | undefined;

    void loadStatus();

    if (status && ["waiting_qr", "waiting_pairing", "connecting"].includes(status.status)) {
      timerId = window.setTimeout(() => {
        void loadStatus({ background: true });
      }, 5000);
    }

    return () => {
      if (timerId) {
        window.clearTimeout(timerId);
      }
    };
  }, [status?.status, token]);

  async function wrapAction(action: () => Promise<BotStatusResponse>, successMessage?: string) {
    workerBootstrapRunRef.current += 1;
    qrBindingRunRef.current += 1;
    setIsBusy(true);
    setPageError(null);
    setActionError(null);
    setActionMessage(null);
    setPollingError(null);
    setClientBotMessage(null);
    setClientBotProgressMessage(null);
    setIsWaitingForWorker(false);

    try {
      const nextStatus = await action();
      setStatus(nextStatus);
      if (successMessage) {
        setActionMessage(successMessage);
      }
      return nextStatus;
    } catch (actionError) {
      setActionError(getErrorMessage(actionError, "Operazione fallita."));
      return null;
    } finally {
      setIsBusy(false);
    }
  }

  async function bindQrFromWorker() {
    if (!token) {
      return;
    }

    const runId = qrBindingRunRef.current + 1;
    qrBindingRunRef.current = runId;
    setPollingError("Sto cercando il QR...");

    for (let attempt = 1; attempt <= QR_BIND_MAX_ATTEMPTS; attempt += 1) {
      if (qrBindingRunRef.current !== runId) {
        return;
      }

      try {
        const nextStatus = await apiClient.getQr(token);
        if (qrBindingRunRef.current !== runId) {
          return;
        }

        setStatus(nextStatus);

        if (
          hasVisibleQr(nextStatus) ||
          nextStatus.status === "waiting_pairing" ||
          nextStatus.status === "connected" ||
          nextStatus.status === "error"
        ) {
          setPollingError(null);
          return;
        }
      } catch (error) {
        if (qrBindingRunRef.current !== runId) {
          return;
        }

        if (!isRetryableError(error)) {
          setPollingError(getErrorMessage(error, "Non riesco a leggere il QR in questo momento."));
          return;
        }
      }

      await wait(QR_BIND_INTERVAL_MS);
    }

    if (qrBindingRunRef.current !== runId) {
      return;
    }

    setPollingError("Il servizio è attivo ma il QR non è ancora visibile. Continuo ad aggiornare la pagina.");
  }

  async function handleInit(mode: ConnectionMode) {
    if (!token) {
      return;
    }
    const nextStatus = await wrapAction(
      () => apiClient.initBotConnection(token, mode),
      mode === "pairing" ? "Richiesta codice avviata." : "Richiesta QR avviata.",
    );
    if (mode === "qr" && nextStatus && !hasVisibleQr(nextStatus) && nextStatus.status !== "connected") {
      void bindQrFromWorker();
    }
  }

  async function handleRefreshQr() {
    if (!token) {
      return;
    }
    const nextStatus = await wrapAction(() => apiClient.getQr(token), "QR aggiornato.");
    if (nextStatus && !hasVisibleQr(nextStatus) && nextStatus.status === "waiting_qr") {
      void bindQrFromWorker();
    }
  }

  async function handleRefreshPairing() {
    if (!token) {
      return;
    }
    await wrapAction(() => apiClient.getPairingCode(token), "Codice aggiornato.");
  }

  async function handleDisconnect() {
    if (!token) {
      return;
    }
    await wrapAction(() => apiClient.disconnectBot(token), "WhatsApp disconnesso correttamente.");
  }

  async function waitForWorkerAfterStart(runId: number) {
    if (!token) {
      return;
    }

    setIsWaitingForWorker(true);

    for (let attempt = 1; attempt <= WORKER_BOOT_MAX_ATTEMPTS; attempt += 1) {
      if (workerBootstrapRunRef.current !== runId) {
        return;
      }

      setClientBotProgressMessage(
        `Sto avviando il servizio locale (${attempt}/${WORKER_BOOT_MAX_ATTEMPTS}). Appena risponde, potrai collegare WhatsApp da qui.`,
      );

      const completed = await tryFinalizeWorkerBootstrap(runId);
      if (completed) {
        return;
      }

      if (attempt < WORKER_BOOT_MAX_ATTEMPTS) {
        await wait(WORKER_BOOT_INTERVAL_MS);
      }
    }

    if (workerBootstrapRunRef.current !== runId) {
      return;
    }

    setIsWaitingForWorker(false);
    setClientBotProgressMessage(null);
    setPollingError(
      "L'avvio sta richiedendo più tempo del previsto. Continuo a controllare e ti avviso appena è tutto pronto.",
    );
    void continueWaitingForWorkerInBackground(runId);
  }

  async function handleStartClientBot() {
    if (!token || !canStartLocalBot) {
      return;
    }

    const runId = workerBootstrapRunRef.current + 1;
    workerBootstrapRunRef.current = runId;
    setIsStartingClientBot(true);
    setPageError(null);
    setActionError(null);
    setPollingError(null);
    setClientBotMessage(null);
    setClientBotProgressMessage(null);
    setIsWaitingForWorker(false);

    try {
      const result = await apiClient.startClientBot(token, clientBotDirectory);
      setClientBotMessage(
        `${result.message}${result.pid ? ` PID iniziale: ${result.pid}.` : ""}`,
      );
      if (result.command === "already-running") {
        const completed = await tryFinalizeWorkerBootstrap(runId);
        if (!completed) {
          await loadStatus({ background: true });
        }
        return;
      }

      if (result.bootsWorker) {
        await waitForWorkerAfterStart(runId);
      }
    } catch (actionError) {
      setActionError(getErrorMessage(actionError, "Non sono riuscito ad avviare il servizio locale."));
    } finally {
      setIsStartingClientBot(false);
    }
  }

  return (
    <div className="page-stack">
      {pageError ? <p className="error-banner">{pageError}</p> : null}
      {actionError ? <p className="error-banner">{actionError}</p> : null}
      {actionMessage ? <p className="success-banner">{actionMessage}</p> : null}
      {pollingError ? <p className="warning-banner">{pollingError}</p> : null}
      <BotStatusCard isBusy={isBusy} onDisconnect={handleDisconnect} status={status} />
      <ConnectionCard
        status={status}
        portalUserLabel={portalUserLabel}
        onInit={handleInit}
        onRefreshQr={handleRefreshQr}
        onRefreshPairing={handleRefreshPairing}
        clientBotDirectory={clientBotDirectory}
        clientBotMessage={clientBotMessage}
        clientBotProgressMessage={clientBotProgressMessage}
        isStartingClientBot={isStartingClientBot}
        isWaitingForWorker={isWaitingForWorker}
        canStartLocalBot={canStartLocalBot}
        onChangeClientBotDirectory={setClientBotDirectory}
        onStartClientBot={handleStartClientBot}
        isBusy={isBusy}
      />
    </div>
  );
}
