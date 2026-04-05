import { useEffect, useMemo, useState } from "react";

import type {
  BotDataField,
  BotDataModel,
  BotDataRow,
  BotStatusResponse,
  ExecuteBotSqlResponse,
  PortalUser,
} from "@whatsapp-ai/shared";
import { isSystemAdminRole } from "@whatsapp-ai/shared";

import { useAuth } from "../auth/useAuth";
import { BotStatusCard } from "../components/BotStatusCard";
import { apiClient, getErrorMessage } from "../lib/api";

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
const sensitiveFieldPattern =
  /(password|passwd|pwd|secret|token|hash|email|mail|phone|telefono|mobile|cell|whatsapp|session|cookie|authorization|credential|api[_-]?key|access[_-]?key|private[_-]?key|path|dir|directory|folder|file|filepath|location)/i;
const pathLikeValuePattern =
  /^(?:[a-z]:[\\/]|\\\\|\/(?:users|home|var|srv|opt|tmp|etc|root|app|workspace|data)\b)/i;

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

function isSensitiveField(field: Pick<BotDataField, "name">) {
  return sensitiveFieldPattern.test(field.name);
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
        const message = getErrorMessage(error, `Errore nel campo ${humanizeFieldName(field.name)}.`);
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

function stringifyPreviewValue(value: unknown) {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "boolean") {
    return value ? "Si" : "No";
  }

  if (typeof value === "object") {
    return stringifyJson(value);
  }

  return String(value);
}

function isPathLikeString(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }

  if (pathLikeValuePattern.test(trimmed)) {
    return true;
  }

  const slashCount = (trimmed.match(/[\\/]/g) ?? []).length;
  return slashCount >= 3 && !/^https?:\/\//i.test(trimmed);
}

function redactPreviewString(key: string, value: string) {
  const normalizedKey = key.toLowerCase();

  if (isPathLikeString(value) || /(path|dir|directory|folder|file|filepath|location)/i.test(normalizedKey)) {
    return "[percorso occultato]";
  }

  if (value.includes("@") || /(email|mail)/i.test(normalizedKey)) {
    const [local, domain] = value.split("@");
    if (!domain) {
      return "[email occultata]";
    }

    return `${local.slice(0, 2) || local.charAt(0)}***@${domain}`;
  }

  if (/(phone|telefono|mobile|cell|whatsapp)/i.test(normalizedKey) || /^\+?[0-9\s().-]{7,}$/.test(value)) {
    const digits = value.replace(/\D/g, "");
    if (digits.length >= 6) {
      return `${digits.slice(0, 2)}***${digits.slice(-2)}`;
    }

    return "[numero occultato]";
  }

  if (sensitiveFieldPattern.test(key)) {
    return "[dato sensibile occultato]";
  }

  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 120 ? `${compact.slice(0, 120)}...` : compact;
}

function redactPreviewValue(key: string, value: unknown): string {
  if (value === null || value === undefined || value === "") {
    return "—";
  }

  if (typeof value === "boolean") {
    return value ? "Si" : "No";
  }

  if (typeof value === "string") {
    return redactPreviewString(key, value);
  }

  if (typeof value === "object") {
    return "[json]";
  }

  return String(value);
}

function rowMatchesQuery(model: BotDataModel, row: DraftRow, query: string) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return true;
  }

  return model.fields.some((field) => {
    const value = row.values[field.name];
    return [field.name, humanizeFieldName(field.name), stringifyPreviewValue(value)]
      .join(" ")
      .toLowerCase()
      .includes(normalizedQuery);
  });
}

function formatCellPreview(field: BotDataField, value: DraftValue) {
  return redactPreviewValue(field.name, value);
}

function escapeSqlIdentifier(value: string) {
  return `"${value.replace(/"/g, "\"\"")}"`;
}

function defaultSqlForModel(model: BotDataModel) {
  return `SELECT *\nFROM ${escapeSqlIdentifier(model.dbName ?? model.name)}\nLIMIT 50`;
}

function statusLabel(status: BotStatusResponse | null) {
  switch (status?.status) {
    case "connected":
      return "Operativo";
    case "waiting_qr":
      return "In attesa QR";
    case "waiting_pairing":
      return "In attesa codice";
    case "connecting":
      return "Connessione in corso";
    case "error":
      return "Errore";
    case "disconnected":
      return "Disconnesso";
    default:
      return "Da inizializzare";
  }
}

function connectionModeLabel(status: BotStatusResponse | null) {
  if (status?.connectionMode === "pairing") {
    return "Codice di pairing";
  }

  if (status?.connectionMode === "qr") {
    return "QR code";
  }

  return "Da scegliere";
}

export function BotDatabasePage() {
  const { token, user } = useAuth();
  const [models, setModels] = useState<BotDataModel[]>([]);
  const [status, setStatus] = useState<BotStatusResponse | null>(null);
  const [selectedModelName, setSelectedModelName] = useState("");
  const [draftRows, setDraftRows] = useState<DraftRow[]>([]);
  const [redactedColumns, setRedactedColumns] = useState<string[]>([]);
  const [rowQuery, setRowQuery] = useState("");
  const [sqlCommand, setSqlCommand] = useState("");
  const [sqlResult, setSqlResult] = useState<ExecuteBotSqlResponse | null>(null);
  const [sqlAllowWrite, setSqlAllowWrite] = useState(false);
  const [sqlError, setSqlError] = useState<string | null>(null);
  const [isLoadingModels, setIsLoadingModels] = useState(true);
  const [isLoadingRows, setIsLoadingRows] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isRunningSql, setIsRunningSql] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const selectedModel = useMemo(
    () => models.find((model) => model.name === selectedModelName) ?? null,
    [models, selectedModelName],
  );
  const isSystemAdmin = useMemo(() => isSystemAdminRole(user?.role), [user?.role]);
  const filteredRows = useMemo(() => {
    if (!selectedModel) {
      return [];
    }

    return draftRows.filter((row) => rowMatchesQuery(selectedModel, row, rowQuery));
  }, [draftRows, rowQuery, selectedModel]);
  const previewFields = useMemo(() => selectedModel?.fields.slice(0, 8) ?? [], [selectedModel]);
  const sqlResultColumns = useMemo(() => sqlResult?.columns ?? [], [sqlResult]);
  const dashboardLastUpdateLabel = status ? new Date(status.updatedAt).toLocaleString("it-IT") : "Nessun dato ancora";

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
      setError(getErrorMessage(loadError, "Impossibile leggere le tabelle del bot."));
    } finally {
      setIsLoadingModels(false);
    }
  }

  async function loadStatus() {
    if (!token) {
      return;
    }

    try {
      const nextStatus = await apiClient.getBotStatus(token);
      setStatus(nextStatus);
    } catch (loadError) {
      setError((current) => current ?? getErrorMessage(loadError, "Impossibile leggere le analitiche del bot."));
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
      setRedactedColumns(response.redactedColumns ?? []);
    } catch (loadError) {
      setError(getErrorMessage(loadError, "Impossibile leggere i dati della tabella."));
    } finally {
      setIsLoadingRows(false);
    }
  }

  useEffect(() => {
    void loadModels();
    void loadStatus();
  }, [token]);

  useEffect(() => {
    if (!selectedModelName) {
      setDraftRows([]);
      setRedactedColumns([]);
      return;
    }

    void loadRows(selectedModelName);
  }, [models, selectedModelName]);

  useEffect(() => {
    if (!selectedModel) {
      setSqlCommand("");
      setSqlResult(null);
      setSqlError(null);
      return;
    }

    setSqlCommand(defaultSqlForModel(selectedModel));
    setSqlResult(null);
    setSqlError(null);
    setSqlAllowWrite(false);
  }, [selectedModel]);

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

  async function copySqlText(value: string, successMessage: string) {
    if (!value || typeof navigator === "undefined" || !navigator.clipboard) {
      setMessage("Copia negli appunti non disponibile in questo browser.");
      return;
    }

    try {
      await navigator.clipboard.writeText(value);
      setMessage(successMessage);
    } catch {
      setMessage("Non sono riuscito a copiare il contenuto richiesto.");
    }
  }

  async function executeSql() {
    if (!token || !sqlCommand.trim()) {
      return;
    }

    setIsRunningSql(true);
    setSqlError(null);
    setMessage(null);

    try {
      const result = await apiClient.executeBotSql(token, sqlCommand, sqlAllowWrite);
      setSqlResult(result);
      const summary =
        result.mode === "write"
          ? `Comando SQL eseguito. Righe toccate: ${result.affectedRows ?? 0}.`
          : `Query SQL completata. Righe restituite: ${result.rowCount}.`;
      setMessage(summary);

      if (selectedModel) {
        await loadRows(selectedModel.name);
      }
      await loadStatus();
    } catch (runError) {
      setSqlError(getErrorMessage(runError, "Query SQL non riuscita."));
      setSqlResult(null);
    } finally {
      setIsRunningSql(false);
    }
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
      setError(getErrorMessage(saveError, "Salvataggio non riuscito."));
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDisconnect() {
    if (!token) {
      return;
    }

    setIsDisconnecting(true);
    setError(null);

    try {
      const nextStatus = await apiClient.disconnectBot(token);
      setStatus(nextStatus);
      setMessage("Bot disconnesso dalla console database.");
    } catch (disconnectError) {
      setError(getErrorMessage(disconnectError, "Disconnessione non riuscita."));
    } finally {
      setIsDisconnecting(false);
    }
  }

  if (!isSystemAdmin) {
    return (
      <section className="card">
        <p className="eyebrow">Database bot</p>
        <h2>Accesso limitato</h2>
        <p className="muted">
          L&apos;editor del database e la console SQL sono disponibili solo per il system admin.
        </p>
      </section>
    );
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
        <h2>Console tabelle stile phpMyAdmin</h2>
        <p className="muted">
          Sfoglia i record in vista tabellare, filtra le righe, poi apri solo quelle che vuoi modificare.
          Sotto trovi anche una console SQL per i casi piu' avanzati, con dati sensibili gia' occultati nei risultati.
        </p>

        <div className="hero-metrics">
          <article className="metric-card">
            <span className="metric-label">Stato bot</span>
            <strong>{statusLabel(status)}</strong>
            <p>{status?.isStale ? "Sto leggendo uno snapshot salvato." : "Stato live disponibile dal worker."}</p>
          </article>
          <article className="metric-card">
            <span className="metric-label">Modalita attiva</span>
            <strong>{connectionModeLabel(status)}</strong>
            <p>Ti aiuta a capire se il bot sta lavorando via QR, pairing o sessione gia' pronta.</p>
          </article>
          <article className="metric-card">
            <span className="metric-label">Ultimo aggiornamento</span>
            <strong>{dashboardLastUpdateLabel}</strong>
            <p>Utile mentre confronti record, query SQL e stato del worker nella stessa vista.</p>
          </article>
        </div>

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

          <label>
            Cerca tra righe e campi
            <input
              onChange={(event) => setRowQuery(event.target.value)}
              placeholder="Cerca id, telefono, email, note..."
              type="search"
              value={rowQuery}
            />
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
          <article className="connection-panel">
            <strong>Righe in vista</strong>
            <p className="muted">
              {filteredRows.length} su {draftRows.length}
            </p>
          </article>
        </div>
      </section>

      {error ? <p className="error-banner">{error}</p> : null}
      {message ? <p className="success-banner">{message}</p> : null}
      {!isSystemAdmin && redactedColumns.length > 0 ? (
        <p className="warning-banner">
          Alcuni campi sensibili di questa tabella sono occultati. Solo il system admin puo' visualizzarli o
          modificarli direttamente.
        </p>
      ) : null}

      <BotStatusCard isBusy={isDisconnecting} onDisconnect={handleDisconnect} status={status} />

      <section className="card">
        <div className="card-heading">
          <div>
            <p className="eyebrow">Sfoglia</p>
            <h3>Vista tabellare rapida</h3>
          </div>
          <p className="muted">
            {rowQuery.trim()
              ? `Filtro attivo: ${filteredRows.length} righe corrispondenti`
              : "Anteprima stile phpMyAdmin delle righe attualmente caricate"}
          </p>
        </div>

        {isLoadingRows ? (
          <div className="db-empty">Sto preparando l'anteprima tabellare...</div>
        ) : filteredRows.length === 0 ? (
          <div className="db-empty">
            {draftRows.length === 0
              ? "Nessuna riga da mostrare in questa tabella."
              : "Nessuna riga corrisponde al filtro attuale."}
          </div>
        ) : (
          <div className="db-browser-shell">
            <div className="db-browser-meta">
              <span className="field-badge">Sfoglia</span>
              <span className="muted">
                Prime {previewFields.length} colonne mostrate. Apri la riga sotto per modificare tutti i campi.
              </span>
            </div>

            <div className="db-browser-table-wrap">
              <table className="db-browser-table">
                <thead>
                  <tr>
                    <th>#</th>
                    {previewFields.map((field) => (
                      <th key={field.name}>{humanizeFieldName(field.name)}</th>
                    ))}
                    <th>Stato</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.map((row, index) => (
                    <tr key={row.localId}>
                      <td>{index + 1}</td>
                      {previewFields.map((field) => (
                        <td key={field.name} title={formatCellPreview(field, row.values[field.name] ?? "")}>
                          {formatCellPreview(field, row.values[field.name] ?? "")}
                        </td>
                      ))}
                      <td>{row.isNew ? "Nuova" : "Esistente"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-heading">
          <div>
            <p className="eyebrow">Righe tabella</p>
            <h3>{selectedModel.name}</h3>
          </div>
          <p className="muted">
            {isLoadingRows
              ? "Sto leggendo i record..."
              : `${filteredRows.length} righe visibili su ${draftRows.length} pronte da modificare`}
          </p>
        </div>

        <div className="field-chips">
          {selectedModel.fields.map((field) => (
            <span className="field-chip" key={field.name}>
              {humanizeFieldName(field.name)} - {field.type}
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

        {!isLoadingRows && filteredRows.length > 0 ? (
          <div className="db-row-list">
            {filteredRows.map((row, index) => (
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
                    const fieldIsRestricted = !isSystemAdmin && isSensitiveField(field);

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
                          {fieldIsRestricted ? <span className="field-badge">Solo system admin</span> : null}
                        </div>

                        {fieldIsRestricted ? (
                          <div className="db-field-lock">
                            <strong>Campo sensibile</strong>
                            <p>Solo l&apos;admin del sistema puo&apos; visualizzare o modificare questo valore.</p>
                          </div>
                        ) : kind === "boolean" ? (
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
                          {field.dbName ? ` - Colonna DB: ${field.dbName}` : ""}
                        </span>
                        <span className="field-help">
                          {fieldIsRestricted
                            ? "Valore protetto per sicurezza operativa: il portale lo nasconde ai profili non amministrativi."
                            : helperText}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </details>
            ))}
          </div>
        ) : null}
      </section>

      <section className="card">
        <div className="card-heading">
          <div>
            <p className="eyebrow">SQL</p>
            <h3>Console SQL</h3>
          </div>
          <div className="action-row db-actions">
            <button
              className="ghost-button"
              onClick={() => void copySqlText(sqlCommand, "Comando SQL copiato negli appunti.")}
              type="button"
            >
              Copia comando
            </button>
            <button disabled={isRunningSql || !sqlCommand.trim()} onClick={() => void executeSql()} type="button">
              {isRunningSql ? "Eseguo..." : "Esegui SQL"}
            </button>
          </div>
        </div>

        <p className="warning-banner">
          Solo utenti esperti: i risultati vengono redatti automaticamente per nascondere email, telefoni, token,
          password, percorsi locali e altri valori sensibili.
        </p>
        <p className="muted">
          Una query per volta. Le query di scrittura richiedono l&apos;attivazione esplicita della modalita avanzata.
        </p>

        <label className="editor-label">
          Comando SQL
          <textarea
            className="db-editor"
            onChange={(event) => setSqlCommand(event.target.value)}
            rows={9}
            spellCheck={false}
            value={sqlCommand}
          />
        </label>

        {isSystemAdmin ? (
          <label className="checkbox-row">
            <input
              checked={sqlAllowWrite}
              onChange={(event) => setSqlAllowWrite(event.target.checked)}
              type="checkbox"
            />
            <span>Consenti query di scrittura SQL su questa sessione</span>
          </label>
        ) : (
          <p className="warning-banner">
            La modalita SQL di scrittura e&apos; riservata al system admin. Qui puoi usare solo query di lettura con
            risultati gia&apos; redatti.
          </p>
        )}

        {sqlError ? <p className="error-banner">{sqlError}</p> : null}

        {sqlResult ? (
          <div className="sql-console-results">
            <div className="db-browser-meta">
              <span className="field-badge">{sqlResult.mode === "write" ? "Scrittura" : "Lettura"}</span>
              <span className="field-badge">{sqlResult.statementType.toUpperCase()}</span>
              <span className="muted">
                {sqlResult.mode === "write"
                  ? `Righe toccate: ${sqlResult.affectedRows ?? 0}`
                  : `Righe visibili: ${sqlResult.rowCount}`}
              </span>
              {sqlResult.truncated ? <span className="field-badge">Limitato a 200 righe</span> : null}
            </div>

            {sqlResult.redactedColumns.length > 0 ? (
              <div className="field-chips">
                {sqlResult.redactedColumns.map((column) => (
                  <span className="field-chip" key={column}>
                    Occultato: {column}
                  </span>
                ))}
              </div>
            ) : null}

            {sqlResult.rows.length > 0 ? (
              <div className="db-browser-table-wrap">
                <table className="db-browser-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      {sqlResultColumns.map((column) => (
                        <th key={column}>{humanizeFieldName(column)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sqlResult.rows.map((row, index) => (
                      <tr key={`sql-row-${index}`}>
                        <td>{index + 1}</td>
                        {sqlResultColumns.map((column) => (
                          <td key={column} title={stringifyPreviewValue(row[column])}>
                            {redactPreviewValue(column, row[column])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="db-empty">
                {sqlResult.mode === "write"
                  ? "Il comando e' stato eseguito. Questa istruzione non restituisce righe da mostrare."
                  : "La query non ha restituito righe."}
              </div>
            )}
          </div>
        ) : (
          <div className="db-empty">
            Esegui una query SQL e qui vedrai il risultato tabellare con i dati sensibili gia' occultati.
          </div>
        )}
      </section>
    </div>
  );
}
