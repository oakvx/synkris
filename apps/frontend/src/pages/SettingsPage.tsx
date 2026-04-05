import { useEffect, useState } from "react";

import type { UserSettings } from "@whatsapp-ai/shared";

import { useAuth } from "../auth/useAuth";
import { apiClient, getErrorMessage } from "../lib/api";
import {
  getPushDeviceState,
  isPushSupported,
  sendPushTest,
  subscribeToPush,
  syncExistingPushSubscription,
  type PushDeviceState,
  unsubscribeFromPush,
} from "../lib/push";

const defaultSettings: UserSettings = {
  displayName: "",
  timezone: "Europe/Rome",
  locale: "it-IT",
  preferredConnectionMode: "qr",
  phoneNumber: null,
  notificationsEnabled: true,
};

const defaultPushState: PushDeviceState = {
  enabled: false,
  permission: "unsupported",
  subscribed: false,
  supported: false,
};

const timezoneOptions = [
  { value: "Europe/Rome", label: "Italia (Europe/Rome)" },
  { value: "Europe/London", label: "Regno Unito (Europe/London)" },
  { value: "Europe/Paris", label: "Francia (Europe/Paris)" },
  { value: "Europe/Berlin", label: "Germania (Europe/Berlin)" },
  { value: "Europe/Madrid", label: "Spagna (Europe/Madrid)" },
  { value: "Europe/Amsterdam", label: "Paesi Bassi (Europe/Amsterdam)" },
  { value: "Europe/Zurich", label: "Svizzera (Europe/Zurich)" },
  { value: "Europe/Lisbon", label: "Portogallo (Europe/Lisbon)" },
  { value: "Europe/Athens", label: "Grecia (Europe/Athens)" },
  { value: "UTC", label: "UTC" },
] as const;

const localeOptions = [
  { value: "it-IT", label: "Italiano (it-IT)" },
  { value: "en-US", label: "English (en-US)" },
] as const;

function withCurrentOption(
  options: ReadonlyArray<{ value: string; label: string }>,
  currentValue: string,
  fallbackLabel: string,
) {
  if (!currentValue || options.some((option) => option.value === currentValue)) {
    return options;
  }

  return [{ value: currentValue, label: `${fallbackLabel}: ${currentValue}` }, ...options];
}

function describePermission(permission: PushDeviceState["permission"]) {
  if (permission === "granted") {
    return "consentite";
  }

  if (permission === "denied") {
    return "bloccate dal browser";
  }

  if (permission === "default") {
    return "non ancora autorizzate";
  }

  return "non supportate";
}

export function SettingsPage() {
  const { token } = useAuth();
  const [settings, setSettings] = useState<UserSettings>(defaultSettings);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pushState, setPushState] = useState<PushDeviceState>(defaultPushState);
  const [isPushBusy, setIsPushBusy] = useState(false);
  const [pushMessage, setPushMessage] = useState<string | null>(null);
  const [pushError, setPushError] = useState<string | null>(null);
  const availableTimezoneOptions = withCurrentOption(timezoneOptions, settings.timezone, "Valore salvato");
  const availableLocaleOptions = withCurrentOption(localeOptions, settings.locale, "Valore salvato");

  useEffect(() => {
    let active = true;

    async function loadSettings() {
      if (!token) {
        return;
      }

      try {
        const nextSettings = await apiClient.getSettings(token);
        if (active) {
          setSettings(nextSettings);
        }
      } catch (loadError) {
        if (active) {
          setError(getErrorMessage(loadError, "Non riesco a caricare le impostazioni."));
        }
      } finally {
        if (active) {
          setIsLoading(false);
        }
      }
    }

    void loadSettings();
    return () => {
      active = false;
    };
  }, [token]);

  useEffect(() => {
    let active = true;

    async function loadPushState() {
      if (!token || !isPushSupported()) {
        if (active) {
          setPushState(defaultPushState);
        }
        return;
      }

      try {
        const nextState = await getPushDeviceState(token);
        if (nextState.permission === "granted") {
          await syncExistingPushSubscription(token).catch(() => undefined);
        }

        if (active) {
          setPushState(await getPushDeviceState(token));
        }
      } catch (loadError) {
        if (active) {
          setPushError(getErrorMessage(loadError, "Non riesco a leggere lo stato delle notifiche push."));
        }
      }
    }

    void loadPushState();
    return () => {
      active = false;
    };
  }, [token]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) {
      return;
    }

    setIsSaving(true);
    setError(null);
    setMessage(null);

    try {
      const saved = await apiClient.updateSettings(token, settings);
      setSettings(saved);
      setMessage("Modifiche salvate.");
    } catch (saveError) {
      setError(getErrorMessage(saveError, "Non sono riuscito a salvare le modifiche."));
    } finally {
      setIsSaving(false);
    }
  }

  async function handleEnablePush() {
    if (!token) {
      return;
    }

    setIsPushBusy(true);
    setPushError(null);
    setPushMessage(null);

    try {
      const nextState = await subscribeToPush(token);
      setPushState(nextState);
      setPushMessage(
        nextState.permission === "granted"
          ? "Notifiche push attivate su questo device."
          : "Serve autorizzare le notifiche dal browser per riceverle sul device.",
      );
    } catch (pushEnableError) {
      setPushError(getErrorMessage(pushEnableError, "Non riesco ad attivare le notifiche push."));
    } finally {
      setIsPushBusy(false);
    }
  }

  async function handleDisablePush() {
    if (!token) {
      return;
    }

    setIsPushBusy(true);
    setPushError(null);
    setPushMessage(null);

    try {
      const nextState = await unsubscribeFromPush(token);
      setPushState(nextState);
      setPushMessage("Notifiche push disattivate su questo device.");
    } catch (pushDisableError) {
      setPushError(getErrorMessage(pushDisableError, "Non riesco a disattivare le notifiche push."));
    } finally {
      setIsPushBusy(false);
    }
  }

  async function handleTestPush() {
    if (!token) {
      return;
    }

    setIsPushBusy(true);
    setPushError(null);
    setPushMessage(null);

    try {
      const result = await sendPushTest(token);
      setPushMessage(
        result.delivered > 0
          ? `Notifica di test inviata a ${result.delivered} device collegati.`
          : "Nessun device push attivo per questo account.",
      );
    } catch (pushTestError) {
      setPushError(getErrorMessage(pushTestError, "Non riesco a inviare la notifica di test."));
    } finally {
      setIsPushBusy(false);
    }
  }

  if (isLoading) {
    return <div className="empty-state">Sto caricando le impostazioni...</div>;
  }

  return (
    <div className="page-stack">
      <section className="card">
        <p className="eyebrow">Il tuo account</p>
        <h2>Impostazioni semplici e subito utili</h2>
        <p className="muted">Queste preferenze vengono salvate dal portale e riusate quando lavori o ricolleghi WhatsApp.</p>

        <form className="settings-form" onSubmit={handleSubmit}>
          <label>
            Nome da mostrare
            <input
              value={settings.displayName}
              onChange={(event) => setSettings({ ...settings, displayName: event.target.value })}
            />
          </label>

          <label>
            Fuso orario
            <select
              value={settings.timezone}
              onChange={(event) => setSettings({ ...settings, timezone: event.target.value })}
            >
              {availableTimezoneOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label>
            Lingua
            <select
              value={settings.locale}
              onChange={(event) => setSettings({ ...settings, locale: event.target.value })}
            >
              {availableLocaleOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label>
            Metodo preferito per il collegamento
            <select
              value={settings.preferredConnectionMode}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  preferredConnectionMode: event.target.value as UserSettings["preferredConnectionMode"],
                })
              }
            >
              <option value="qr">QR</option>
              <option value="pairing">Codice</option>
            </select>
          </label>

          <label>
            Numero di contatto
            <input
              value={settings.phoneNumber ?? ""}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  phoneNumber: event.target.value.trim() ? event.target.value : null,
                })
              }
            />
          </label>

          <label className="checkbox-row">
            <input
              checked={settings.notificationsEnabled}
              onChange={(event) => setSettings({ ...settings, notificationsEnabled: event.target.checked })}
              type="checkbox"
            />
            Consenti avvisi del portale e notifiche push per questo account
          </label>

          {error ? <p className="error-banner">{error}</p> : null}
          {message ? <p className="success-banner">{message}</p> : null}

          <button disabled={isSaving} type="submit">
            {isSaving ? "Salvo..." : "Salva"}
          </button>
        </form>
      </section>

      <section className="card push-device-card">
        <p className="eyebrow">Questo device</p>
        <h2>Notifiche push per prenotazioni nuove, modificate e cancellate</h2>
        <p className="muted">
          Quando sono attive, il device riceve notifiche per nuova prenotazione, prenotazione modificata e prenotazione
          cancellata.
        </p>

        <div className="push-status-grid">
          <div className="push-status-box">
            <span className="muted">Supporto browser</span>
            <strong>{pushState.supported ? "Disponibile" : "Non disponibile"}</strong>
          </div>
          <div className="push-status-box">
            <span className="muted">Server push</span>
            <strong>{pushState.enabled ? "Configurato" : "Non configurato"}</strong>
          </div>
          <div className="push-status-box">
            <span className="muted">Permesso</span>
            <strong>{describePermission(pushState.permission)}</strong>
          </div>
          <div className="push-status-box">
            <span className="muted">Stato device</span>
            <strong>{pushState.subscribed ? "Iscritto" : "Non iscritto"}</strong>
          </div>
        </div>

        <div className="push-device-actions">
          <button
            disabled={isPushBusy || !pushState.supported || !pushState.enabled}
            onClick={() => void handleEnablePush()}
            type="button"
          >
            {isPushBusy ? "Attendo..." : "Attiva notifiche push"}
          </button>
          <button
            disabled={isPushBusy || !pushState.subscribed}
            onClick={() => void handleDisablePush()}
            type="button"
          >
            Disattiva su questo device
          </button>
          <button
            disabled={isPushBusy || !pushState.subscribed}
            onClick={() => void handleTestPush()}
            type="button"
          >
            Invia test push
          </button>
        </div>

        {!settings.notificationsEnabled ? (
          <p className="warning-banner">
            Le subscription del device possono esserci, ma finché l'opzione account è spenta il server non invia push operative.
          </p>
        ) : null}
        {!pushState.supported ? (
          <p className="warning-banner">Questo browser non espone Web Push. Prova Chrome, Edge o Safari aggiornato.</p>
        ) : null}
        {pushError ? <p className="error-banner">{pushError}</p> : null}
        {pushMessage ? <p className="success-banner">{pushMessage}</p> : null}

        <p className="muted">
          Nota: su iPhone/iPad le push web richiedono Safari e app salvata in Home Screen. Su desktop e Android servono
          HTTPS oppure localhost in sviluppo.
        </p>
      </section>
    </div>
  );
}
