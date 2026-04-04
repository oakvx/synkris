import { useEffect, useState } from "react";

import type { UserSettings } from "@whatsapp-ai/shared";

import { useAuth } from "../auth/AuthContext";
import { apiClient } from "../lib/api";

const defaultSettings: UserSettings = {
  displayName: "",
  timezone: "Europe/Rome",
  locale: "it-IT",
  preferredConnectionMode: "qr",
  phoneNumber: null,
  notificationsEnabled: true,
};

export function SettingsPage() {
  const { token } = useAuth();
  const [settings, setSettings] = useState<UserSettings>(defaultSettings);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
          setError(loadError instanceof Error ? loadError.message : "Impossibile caricare le impostazioni.");
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
      setMessage("Impostazioni salvate correttamente.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Salvataggio non riuscito.");
    } finally {
      setIsSaving(false);
    }
  }

  if (isLoading) {
    return <div className="empty-state">Sto caricando le impostazioni...</div>;
  }

  return (
    <section className="card">
      <p className="eyebrow">Preferenze account</p>
      <h2>Impostazioni base</h2>
      <p className="muted">Questi dati vivono nel backend e vengono esposti al frontend solo tramite API autenticata.</p>

      <form className="settings-form" onSubmit={handleSubmit}>
        <label>
          Nome visualizzato
          <input
            value={settings.displayName}
            onChange={(event) => setSettings({ ...settings, displayName: event.target.value })}
          />
        </label>

        <label>
          Timezone
          <input
            value={settings.timezone}
            onChange={(event) => setSettings({ ...settings, timezone: event.target.value })}
          />
        </label>

        <label>
          Locale
          <input
            value={settings.locale}
            onChange={(event) => setSettings({ ...settings, locale: event.target.value })}
          />
        </label>

        <label>
          Modalita connessione predefinita
          <select
            value={settings.preferredConnectionMode}
            onChange={(event) =>
              setSettings({
                ...settings,
                preferredConnectionMode: event.target.value as UserSettings["preferredConnectionMode"],
              })
            }
          >
            <option value="qr">QR code</option>
            <option value="pairing">Pairing code</option>
          </select>
        </label>

        <label>
          Telefono contatto
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
          Abilita notifiche del portale
        </label>

        {error ? <p className="error-banner">{error}</p> : null}
        {message ? <p className="success-banner">{message}</p> : null}

        <button disabled={isSaving} type="submit">
          {isSaving ? "Salvataggio..." : "Salva impostazioni"}
        </button>
      </form>
    </section>
  );
}
