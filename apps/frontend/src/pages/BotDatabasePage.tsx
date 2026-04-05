import { useEffect, useMemo, useState } from "react";

import type { BotDataField, BotDataModel, BotDataRow } from "@whatsapp-ai/shared";

import { useAuth } from "../auth/AuthContext";
import { apiClient } from "../lib/api";

type DraftValue = string | boolean | null;
type DraftRow = {
  localId: string;
  isNew: boolean;
  values: Record<string, DraftValue>;
};

type FieldKind =
  | "bigint"
  | "boolean"
  | "datetime"
  | "decimal"
  | "email"
  | "integer"
  | "json"
  | "phone"
  | "text"
  | "textarea"
  | "time";

const phoneFieldPattern = /(phone|telefono|mobile|cell|whatsapp|e164|tel)/i;
const emailFieldPattern = /email/i;
const timeFieldPattern = /(open|close|start|end)time$/i;
const longTextFieldPattern = /(body|description|message|notes|note|metadata|prompt|reply|error)/i;

function makeLocalId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `row-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function humanizeFieldName(name: string) {
  const normalized = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();

  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function inferFieldKind(field: BotDataField): FieldKind {
  if (field.type === "Boolean") {
    return "boolean";
  }

  if (phoneFieldPattern.test(field.name)) {
    return "phone";
  }

  if (emailFieldPattern.test(field.name)) {
    return "email";
  }

  if (field.type === "DateTime") {
    return "datetime";
  }

  if (field.type === "Int") {
    return "integer";
  }

  if (field.type === "BigInt") {
    return "bigint";
  }

  if (field.type === "Float" || field.type === "Decimal") {
    return "decimal";
  }

  if (field.type === "Json" || field.isList) {
    return "json";
  }

  if (timeFieldPattern.test(field.name)) {
    return "time";
  }

  if (longTextFieldPattern.test(field.name)) {
    return "textarea";
  }

  return "text";
}

function toBooleanDraftValue(value: unknown): DraftValue {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }

    if (normalized === "false") {
      return false;
    }
  }

  return null;
}

function toDateTimeLocalInput(value: unknown): string {
  if (!value) {
    return "";
  }

  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }

  const local = new Date(parsed.getTime() - parsed.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function stringifyJson(value: unknown): string {
  if (value === null || value === undefined || value === "") {
    return "";
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatValueForDraft(field: BotDataField, value: unknown): DraftValue {
  if (field.type === "Boolean") {
    return toBooleanDraftValue(value);
  }

  if (value === null || value === undefined) {
    return "";
  }

  if (field.type === "DateTime") {
    return toDateTimeLocalInput(value);
  }

  if (field.type === "Json" || field.isList || typeof value === "object") {
    return stringifyJson(value);
  }

  return String(value);
}

function createEmptyDraftRow(model: BotDataModel): DraftRow {
  return {
    isNew: true,
    localId: makeLocalId(),
    values: Object.fromEntries(
      model.fields.map((field) => [field.name, field.type === "Boolean" ? null : ""]),
    ) as Record<string, DraftValue>,
  };
}

function createDraftRows(model: BotDataModel, rows: BotDataRow[]): DraftRow[] {
  return rows.map((row) => ({
    isNew: false,
    localId: makeLocalId(),
    values: Object.fromEntries(
      model.fields.map((field) => [field.name, formatValueForDraft(field, row[field.name])]),
    ) as Record<string, DraftValue>,
  }));
}

function isBlankDraftValue(value: DraftValue) {
  return value === null || (typeof value === "string" && value.trim() === "");
}

function parseBooleanValue(field: BotDataField, value: DraftValue, isNew: boolean) {
  if (value === true || value === false) {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }

    if (normalized === "false") {
      return false;
    }
  }

  if (isNew && field.hasDefaultValue) {
    return undefined;
  }

  if (!field.isRequired) {
    return null;
  }

  throw new Error(`"${humanizeFieldName(field.name)}" richiede una scelta: Si o No.`);
}

function parseFieldValue(field: BotDataField, value: DraftValue, isNew: boolean): unknown {
  if (field.isUpdatedAt) {
    return undefined;
  }

  if (field.type === "Boolean") {
    return parseBooleanValue(field, value, isNew);
  }

  if (isBlankDraftValue(value)) {
    if (isNew && (field.hasDefaultValue || field.isGenerated)) {
      return undefined;
    }

    if (!field.isRequired) {
      return null;
    }

    throw new Error(`"${humanizeFieldName(field.name)}" e' obbligatorio.`);
  }

  const raw = String(value).trim();

  switch (field.type) {
    case "Int": {
      if (!/^-?\d+$/.test(raw)) {
        throw new Error(`"${humanizeFieldName(field.name)}" deve contenere un numero intero.`);
      }
      return raw;
    }
    case "BigInt": {
      if (!/^-?\d+$/.test(raw)) {
        throw new Error(`"${humanizeFieldName(field.name)}" deve contenere solo cifre.`);
      }
      return raw;
    }
    case "Float":
    case "Decimal": {
      if (!/^-?\d+(?:[.,]\d+)?$/.test(raw)) {
        throw new Error(`"${humanizeFieldName(field.name)}" deve contenere un numero valido.`);
      }
      return raw.replace(",", ".");
    }
    case "DateTime": {
      const parsed = new Date(raw);
      if (Number.isNaN(parsed.getTime())) {
        throw new Error(`"${humanizeFieldName(field.name)}" deve contenere una data valida.`);
      }
      return parsed.toISOString();
    }
    case "Json": {
      try {
        return JSON.parse(raw);
      } catch {
        throw new Error(`"${humanizeFieldName(field.name)}" deve essere JSON valido.`);
      }
    }
    default: {
      if (field.isList) {
        try {
          const parsed = JSON.parse(raw);
          if (!Array.isArray(parsed)) {
            throw new Error();
          }
          return parsed;
        } catch {
          throw new Error(`"${humanizeFieldName(field.name)}" deve essere un array JSON valido.`);
        }
      }

      return raw;
    }
  }
}

function parseDraftRows(model: BotDataModel, rows: DraftRow[]): BotDataRow[] {
  return rows.map((row, rowIndex) => {
    const nextRow: BotDataRow = {};

    for (const field of model.fields) {
      try {
        const parsed = parseFieldValue(field, row.values[field.name] ?? "", row.isNew);
        if (parsed !== undefined) {
          nextRow[field.name] = parsed;
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : `Errore nel campo ${humanizeFieldName(field.name)}.`;
        throw new Error(`Riga ${rowIndex + 1}: ${message}`);
      }
    }

    return nextRow;
  });
}

function countFilledFields(row: DraftRow) {
  return Object.values(row.values).filter((value) => !isBlankDraftValue(value)).length;
}

function rowTitle(model: BotDataModel, row: DraftRow, index: number) {
  const keyValues = model.primaryKey
    .map((fieldName) => row.values[fieldName])
    .filter((value) => !isBlankDraftValue(value))
    .map((value) => String(value));

  if (keyValues.length > 0) {
    return `Riga ${index + 1} - ${keyValues.join(" / ")}`;
  }

  return row.isNew ? `Nuova riga ${index + 1}` : `Riga ${index + 1}`;
}

function placeholderForField(field: BotDataField) {
  switch (inferFieldKind(field)) {
    case "phone":
      return "+39 333 123 4567";
    case "email":
      return "nome@azienda.it";
    case "integer":
      return "Es. 3";
    case "bigint":
      return "Es. 123456";
    case "decimal":
      return "Es. 49.90";
    case "json":
      return field.isList ? '["voce 1", "voce 2"]' : '{"chiave":"valore"}';
    case "time":
      return "09:00";
    case "textarea":
      return "Scrivi qui il contenuto completo.";
    default:
      return `Inserisci ${humanizeFieldName(field.name).toLowerCase()}.`;
  }
}

function helperTextForField(field: BotDataField, model: BotDataModel) {
  const messages: string[] = [];
  const kind = inferFieldKind(field);

  if (model.primaryKey.includes(field.name)) {
    messages.push("Campo chiave della riga: serve per capire quale record aggiornare.");
  }

  switch (kind) {
    case "phone":
      messages.push("Inserisci un numero di telefono, ad esempio +39 333 123 4567.");
      break;
    case "email":
      messages.push("Inserisci un indirizzo email completo.");
      break;
    case "integer":
      messages.push("Inserisci un numero intero.");
      break;
    case "bigint":
      messages.push("Inserisci solo cifre, senza lettere.");
      break;
    case "decimal":
      messages.push("Inserisci un numero, anche con decimali.");
      break;
    case "datetime":
      messages.push("Scegli data e ora complete.");
      break;
    case "json":
      messages.push("Inserisci JSON valido. Se e' una lista, usa le parentesi quadre.");
      break;
    case "time":
      messages.push("Inserisci un orario nel formato HH:MM.");
      break;
    case "textarea":
      messages.push("Qui puoi scrivere un testo lungo.");
      break;
    default:
      messages.push("Campo testuale semplice.");
      break;
  }

  if (!field.isRequired) {
    messages.push("Puoi lasciarlo vuoto se non ti serve.");
  }

  if (field.hasDefaultValue) {
    messages.push("Nelle nuove righe puoi lasciarlo vuoto per usare il valore predefinito.");
  }

  if (field.isUpdatedAt) {
    messages.push("Si aggiorna da solo quando salvi.");
  }

  return messages.join(" ");
}

function boolSelectValue(value: DraftValue) {
  if (value === true) {
    return "true";
  }

  if (value === false) {
    return "false";
  }

  return "";
}

function modelLabel(model: BotDataModel) {
  return model.dbName ? `${model.name} (${model.dbName})` : model.name;
}

export function BotDatabasePage() {
  const { token } = useAuth();
  const [models, setModels] = useState<BotDataModel[]>([]);
  const [selectedModelName, setSelectedModelName] = useState("");
  const [draftRows, setDraftRows] = useState<DraftRow[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(true);
  const [isLoadingRows, setIsLoadingRows] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const selectedModel = useMemo(
    () => models.find((model) => model.name === selectedModelName) ?? null,
    [models, selectedModelName],
  );

  async function loadModels() {
    if (!token) {
      return;
    }

    setIsLoadingModels(true);
    setError(null);

    try {
      const response = await apiClient.getBotDataModels(token);
      setModels(response.models);
      setSelectedModelName((current) => {
        if (current && response.models.some((model) => model.name === current)) {
          return current;
        }

        return response.models[0]?.name ?? "";
      });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Impossibile leggere le tabelle del bot.");
    } finally {
      setIsLoadingModels(false);
    }
  }

  async function loadRows(modelName: string) {
    if (!token || !modelName) {
      return;
    }

    const model = models.find((entry) => entry.name === modelName);
    if (!model) {
      return;
    }

    setIsLoadingRows(true);
    setError(null);
    setMessage(null);

    try {
      const response = await apiClient.getBotDataRows(token, modelName);
      setDraftRows(createDraftRows(model, response.rows));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Impossibile leggere i dati della tabella.");
    } finally {
      setIsLoadingRows(false);
    }
  }

  useEffect(() => {
    void loadModels();
  }, [token]);

  useEffect(() => {
    if (!selectedModelName) {
      setDraftRows([]);
      return;
    }

    void loadRows(selectedModelName);
  }, [models, selectedModelName]);

  function updateFieldValue(rowId: string, fieldName: string, value: DraftValue) {
    setDraftRows((current) =>
      current.map((row) =>
        row.localId === rowId
          ? {
              ...row,
              values: {
                ...row.values,
                [fieldName]: value,
              },
            }
          : row,
      ),
    );
    setMessage(null);
  }

  function addRow() {
    if (!selectedModel) {
      return;
    }

    setDraftRows((current) => [...current, createEmptyDraftRow(selectedModel)]);
    setMessage(null);
  }

  function removeRow(localId: string) {
    setDraftRows((current) => current.filter((row) => row.localId !== localId));
    setMessage(null);
  }

  async function handleSave() {
    if (!token || !selectedModel) {
      return;
    }

    setIsSaving(true);
    setError(null);
    setMessage(null);

    try {
      const payload = parseDraftRows(selectedModel, draftRows);
      const saved = await apiClient.saveBotDataRows(token, selectedModel.name, payload);
      setDraftRows(createDraftRows(selectedModel, saved.rows));
      setMessage(`Tabella ${selectedModel.name} salvata. Righe attuali: ${saved.rowCount}.`);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Salvataggio non riuscito.");
    } finally {
      setIsSaving(false);
    }
  }

  if (isLoadingModels) {
    return <div className="empty-state">Sto preparando l'editor del database...</div>;
  }

  if (!selectedModel) {
    return (
      <section className="card">
        <p className="eyebrow">Database bot</p>
        <h2>Nessuna tabella disponibile</h2>
        <p className="muted">Al momento non ci sono modelli esposti dal backend.</p>
      </section>
    );
  }

  return (
    <div className="page-stack">
      <section className="hero-card">
        <p className="eyebrow">Database bot</p>
        <h2>Editor semplice delle tabelle</h2>
        <p className="muted">
          Ogni campo mostra il tipo di dato in modo pratico, con esempi e istruzioni semplici prima del
          salvataggio.
        </p>

        <div className="db-toolbar">
          <label>
            Tabella da gestire
            <select
              value={selectedModel.name}
              onChange={(event) => setSelectedModelName(event.target.value)}
            >
              {models.map((model) => (
                <option key={model.name} value={model.name}>
                  {modelLabel(model)}
                </option>
              ))}
            </select>
          </label>

          <div className="action-row db-actions">
            <button className="ghost-button" disabled={isLoadingRows || isSaving} onClick={() => void loadRows(selectedModel.name)}>
              {isLoadingRows ? "Ricarico..." : "Ricarica dati"}
            </button>
            <button className="ghost-button" disabled={isLoadingRows || isSaving} onClick={addRow}>
              Aggiungi riga
            </button>
            <button disabled={isLoadingRows || isSaving} onClick={() => void handleSave()}>
              {isSaving ? "Salvataggio..." : "Salva modifiche"}
            </button>
          </div>
        </div>

        <div className="db-meta-grid">
          <article className="connection-panel">
            <strong>Nome modello</strong>
            <p className="muted">{selectedModel.name}</p>
          </article>
          <article className="connection-panel">
            <strong>Tabella database</strong>
            <p className="muted">{selectedModel.dbName ?? "Nome automatico Prisma"}</p>
          </article>
          <article className="connection-panel">
            <strong>Chiave primaria</strong>
            <p className="muted">{selectedModel.primaryKey.map(humanizeFieldName).join(", ") || "Non trovata"}</p>
          </article>
          <article className="connection-panel">
            <strong>Campi disponibili</strong>
            <p className="muted">{selectedModel.fields.length}</p>
          </article>
        </div>
      </section>

      {error ? <p className="error-banner">{error}</p> : null}
      {message ? <p className="success-banner">{message}</p> : null}

      <section className="card">
        <div className="card-heading">
          <div>
            <p className="eyebrow">Righe tabella</p>
            <h3>{selectedModel.name}</h3>
          </div>
          <p className="muted">
            {isLoadingRows ? "Sto leggendo i record..." : `${draftRows.length} righe pronte da modificare`}
          </p>
        </div>

        <div className="field-chips">
          {selectedModel.fields.map((field) => (
            <span className="field-chip" key={field.name}>
              {humanizeFieldName(field.name)} · {field.type}
            </span>
          ))}
        </div>

        {isLoadingRows ? <div className="db-empty">Sto caricando i record della tabella...</div> : null}

        {!isLoadingRows && draftRows.length === 0 ? (
          <div className="db-empty">
            <p>Nessuna riga presente in questa tabella.</p>
            <button className="ghost-button" onClick={addRow}>
              Crea la prima riga
            </button>
          </div>
        ) : null}

        {!isLoadingRows && draftRows.length > 0 ? (
          <div className="db-row-list">
            {draftRows.map((row, index) => (
              <details className="db-row-card" key={row.localId} open={row.isNew || index === 0}>
                <summary className="db-row-summary">
                  <div>
                    <div className="db-row-title">{rowTitle(selectedModel, row, index)}</div>
                    <div className="db-row-subtitle">
                      {countFilledFields(row)} campi compilati su {selectedModel.fields.length}
                    </div>
                  </div>
                  <span className="field-badge">{row.isNew ? "Nuova" : "Esistente"}</span>
                </summary>

                <div className="db-row-actions">
                  <button className="danger-button" onClick={() => removeRow(row.localId)} type="button">
                    Elimina riga
                  </button>
                </div>

                <div className="db-fields-grid">
                  {selectedModel.fields.map((field) => {
                    const kind = inferFieldKind(field);
                    const value = row.values[field.name];
                    const helperText = helperTextForField(field, selectedModel);

                    return (
                      <label className="db-field" key={field.name}>
                        <span>{humanizeFieldName(field.name)}</span>

                        <div className="field-badges">
                          <span className="field-badge">{field.type}</span>
                          {selectedModel.primaryKey.includes(field.name) ? (
                            <span className="field-badge">Chiave</span>
                          ) : null}
                          {field.isRequired ? <span className="field-badge">Obbligatorio</span> : null}
                          {field.isUnique ? <span className="field-badge">Unico</span> : null}
                          {field.hasDefaultValue ? <span className="field-badge">Default</span> : null}
                          {field.isGenerated ? <span className="field-badge">Generato</span> : null}
                        </div>

                        {kind === "boolean" ? (
                          <select
                            value={boolSelectValue(value)}
                            onChange={(event) => {
                              const nextValue =
                                event.target.value === ""
                                  ? null
                                  : event.target.value === "true";
                              updateFieldValue(row.localId, field.name, nextValue);
                            }}
                          >
                            <option value="">
                              {field.hasDefaultValue && row.isNew ? "Usa valore predefinito" : "Seleziona"}
                            </option>
                            <option value="true">Si</option>
                            <option value="false">No</option>
                          </select>
                        ) : kind === "json" || kind === "textarea" ? (
                          <textarea
                            onChange={(event) => updateFieldValue(row.localId, field.name, event.target.value)}
                            placeholder={placeholderForField(field)}
                            rows={kind === "json" ? 7 : 4}
                            value={typeof value === "string" ? value : ""}
                          />
                        ) : (
                          <input
                            onChange={(event) => updateFieldValue(row.localId, field.name, event.target.value)}
                            placeholder={placeholderForField(field)}
                            type={
                              kind === "email"
                                ? "email"
                                : kind === "phone"
                                  ? "tel"
                                  : kind === "decimal" || kind === "integer"
                                    ? "number"
                                    : kind === "datetime"
                                      ? "datetime-local"
                                      : kind === "time"
                                        ? "time"
                                        : "text"
                            }
                            value={typeof value === "string" ? value : ""}
                          />
                        )}

                        <span className="field-meta">
                          Nome tecnico: {field.name}
                          {field.dbName ? ` · Colonna DB: ${field.dbName}` : ""}
                        </span>
                        <span className="field-help">{helperText}</span>
                      </label>
                    );
                  })}
                </div>
              </details>
            ))}
          </div>
        ) : null}
      </section>
    </div>
  );
}
