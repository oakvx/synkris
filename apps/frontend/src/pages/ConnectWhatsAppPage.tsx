import { useEffect, useState } from "react";

import type { BotStatusResponse, ConnectionMode } from "@whatsapp-ai/shared";

import { useAuth } from "../auth/AuthContext";
import { BotStatusCard } from "../components/BotStatusCard";
import { ConnectionCard } from "../components/ConnectionCard";
import { apiClient } from "../lib/api";

export function ConnectWhatsAppPage() {
  const { token } = useAuth();
  const [status, setStatus] = useState<BotStatusResponse | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadStatus() {
    if (!token) {
      return;
    }

    const nextStatus = await apiClient.getBotStatus(token);
    setStatus(nextStatus);
  }

  useEffect(() => {
    let timerId: number | undefined;

    void loadStatus().catch((loadError) => {
      setError(loadError instanceof Error ? loadError.message : "Impossibile leggere lo stato corrente.");
    });

    if (status && ["waiting_qr", "waiting_pairing", "connecting"].includes(status.status)) {
      timerId = window.setTimeout(() => {
        void loadStatus().catch(() => undefined);
      }, 5000);
    }

    return () => {
      if (timerId) {
        window.clearTimeout(timerId);
      }
    };
  }, [status?.status, token]);

  async function wrapAction(action: () => Promise<BotStatusResponse>) {
    setIsBusy(true);
    setError(null);

    try {
      const nextStatus = await action();
      setStatus(nextStatus);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Operazione fallita.");
    } finally {
      setIsBusy(false);
    }
  }

  async function handleInit(mode: ConnectionMode) {
    if (!token) {
      return;
    }
    await wrapAction(() => apiClient.initBotConnection(token, mode));
  }

  async function handleRefreshQr() {
    if (!token) {
      return;
    }
    await wrapAction(() => apiClient.getQr(token));
  }

  async function handleRefreshPairing() {
    if (!token) {
      return;
    }
    await wrapAction(() => apiClient.getPairingCode(token));
  }

  async function handleDisconnect() {
    if (!token) {
      return;
    }
    await wrapAction(() => apiClient.disconnectBot(token));
  }

  return (
    <div className="page-stack">
      {error ? <p className="error-banner">{error}</p> : null}
      <BotStatusCard status={status} />
      <ConnectionCard
        status={status}
        onInit={handleInit}
        onRefreshQr={handleRefreshQr}
        onRefreshPairing={handleRefreshPairing}
        onDisconnect={handleDisconnect}
        isBusy={isBusy}
      />
    </div>
  );
}
