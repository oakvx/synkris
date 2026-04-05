import type {
  BotEvent,
  BotStatusResponse,
  OperationsAppointment,
  UserSettings,
} from "@whatsapp-ai/shared";

export type DashboardTab =
  | "overview"
  | "calendar"
  | "appointments"
  | "clients"
  | "whatsapp"
  | "analytics"
  | "tools";

export type FeedItem = {
  id: string;
  label: string;
  meta: string;
  tone: "success" | "warning" | "danger" | "neutral";
  type: string;
};

export type DayBucket = {
  key: string;
  label: string;
  items: OperationsAppointment[];
};

export type RankedMetric = {
  label: string;
  count: number;
};

export type AttentionCard = {
  title: string;
  body: string;
  tone: FeedItem["tone"];
};

export const dashboardTabs: Array<{ id: DashboardTab; label: string; hint: string }> = [
  { id: "overview", label: "Panoramica", hint: "KPI e focus" },
  { id: "calendar", label: "Agenda", hint: "I prossimi giorni" },
  { id: "appointments", label: "Prenotazioni", hint: "Filtri rapidi" },
  { id: "clients", label: "Clienti", hint: "Rubrica operativa" },
  { id: "whatsapp", label: "WhatsApp", hint: "Stato e diagnostica" },
  { id: "analytics", label: "Analisi", hint: "Carico e trend" },
  { id: "tools", label: "Strumenti", hint: "Scorciatoie e moduli" },
];

export function formatDateTime(value: string | null) {
  if (!value) {
    return "Nessun dato";
  }

  return new Date(value).toLocaleString("it-IT");
}

export function formatDateLabel(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  return date.toLocaleDateString("it-IT", {
    weekday: "short",
    day: "2-digit",
    month: "short",
  });
}

export function formatDateLong(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  return date.toLocaleDateString("it-IT", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

export function formatTime(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  return date.toLocaleTimeString("it-IT", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function sameDay(left: Date, right: Date) {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

export function appointmentWindow(appointment: OperationsAppointment) {
  const start = new Date(appointment.startTime);
  const end = new Date(appointment.endTime);
  return `${formatDateLabel(start)} · ${formatTime(start)} - ${formatTime(end)}`;
}

export function appointmentStatusLabel(status: string) {
  switch (status) {
    case "confirmed":
      return "Confermato";
    case "pending":
      return "In attesa";
    case "cancelled":
      return "Annullato";
    case "completed":
      return "Completato";
    case "no_show":
      return "No-show";
    default:
      return status;
  }
}

export function appointmentStatusTone(status: string) {
  switch (status) {
    case "confirmed":
    case "completed":
      return "success";
    case "pending":
      return "warning";
    case "cancelled":
    case "no_show":
      return "danger";
    default:
      return "neutral";
  }
}

export function botStatusLabel(status: BotStatusResponse["status"] | undefined) {
  switch (status) {
    case "connected":
      return "Pronto";
    case "waiting_qr":
      return "In attesa del QR";
    case "waiting_pairing":
      return "In attesa del codice";
    case "connecting":
      return "Collegamento in corso";
    case "error":
      return "Serve attenzione";
    case "disconnected":
      return "Non collegato";
    default:
      return "Da controllare";
  }
}

export function connectionModeLabel(
  mode: UserSettings["preferredConnectionMode"] | BotStatusResponse["connectionMode"] | null | undefined,
) {
  return mode === "pairing" ? "Codice" : mode === "qr" ? "QR" : "Non impostato";
}

export function eventTone(level: BotEvent["level"] | string): FeedItem["tone"] {
  if (level === "success" || level === "info") {
    return "success";
  }

  if (level === "warning") {
    return "warning";
  }

  if (level === "error") {
    return "danger";
  }

  return "neutral";
}

export function rankedFromMap(map: Map<string, number>) {
  return Array.from(map.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((left, right) => right.count - left.count);
}
