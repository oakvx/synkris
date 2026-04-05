import { useEffect, useState } from "react";

import type { BotStatusResponse } from "@whatsapp-ai/shared";

import { apiClient, getErrorMessage } from "../../lib/api";

const BOT_STATUS_POLL_INTERVAL_MS = 30_000;

type UseDashboardBotStatusOptions = {
  token?: string | null;
  initialStatus: BotStatusResponse | null;
  reloadKey?: number;
};

export function useDashboardBotStatus({
  token,
  initialStatus,
  reloadKey = 0,
}: UseDashboardBotStatusOptions) {
  const [status, setStatus] = useState<BotStatusResponse | null>(initialStatus);
  const [pollError, setPollError] = useState<string | null>(null);

  useEffect(() => {
    if (initialStatus) {
      setStatus(initialStatus);
    }
  }, [initialStatus]);

  useEffect(() => {
    if (!token) {
      setPollError(null);
      return;
    }

    let active = true;

    async function refreshStatus() {
      try {
        const nextStatus = await apiClient.getBotStatus(token);
        if (!active) {
          return;
        }

        setStatus(nextStatus);
        setPollError(null);
      } catch (error) {
        if (!active) {
          return;
        }

        setPollError(getErrorMessage(error, "Non riesco ad aggiornare lo stato di WhatsApp."));
      }
    }

    void refreshStatus();

    const intervalId = window.setInterval(() => {
      void refreshStatus();
    }, BOT_STATUS_POLL_INTERVAL_MS);

    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, [reloadKey, token]);

  return {
    status,
    setStatus,
    pollError,
  };
}
