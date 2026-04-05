import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import type {
  AuditEvent,
  BotDiagnosticsResponse,
  OperationsAppointment,
  OperationsClient,
  OperationsSummary,
  UserSettings,
} from "@whatsapp-ai/shared";
import { isSystemAdminRole } from "@whatsapp-ai/shared";

import { useAuth } from "../auth/useAuth";
import { AnalyticsSection } from "../features/dashboard/sections/AnalyticsSection";
import { AppointmentsSection } from "../features/dashboard/sections/AppointmentsSection";
import { CalendarSection } from "../features/dashboard/sections/CalendarSection";
import { ClientsSection } from "../features/dashboard/sections/ClientsSection";
import { OverviewSection } from "../features/dashboard/sections/OverviewSection";
import { ToolsSection } from "../features/dashboard/sections/ToolsSection";
import { WhatsAppSection } from "../features/dashboard/sections/WhatsAppSection";
import {
  appointmentWindow,
  botStatusLabel,
  connectionModeLabel,
  dashboardTabs,
  eventTone,
  formatDateLong,
  rankedFromMap,
  sameDay,
  type AttentionCard,
  type DashboardTab,
  type DayBucket,
  type FeedItem,
} from "../features/dashboard/dashboardView";
import { useDashboardBotStatus } from "../features/dashboard/useDashboardBotStatus";
import { apiClient, getErrorMessage } from "../lib/api";

const emptySummary: OperationsSummary = {
  totalClients: 0,
  upcomingAppointments: 0,
  todayAppointments: 0,
  activeHolds: 0,
  activeChatSessions: 0,
  activeProfessionals: 0,
};

const emptySettings: UserSettings = {
  displayName: "",
  timezone: "Europe/Rome",
  locale: "it-IT",
  preferredConnectionMode: "qr",
  phoneNumber: null,
  notificationsEnabled: true,
};

const APPOINTMENTS_PAGE_SIZE = 24;
const CLIENTS_PAGE_SIZE = 24;

function csvCell(value: unknown) {
  const raw = Array.isArray(value) ? value.join(" | ") : String(value ?? "");
  return `"${raw.replace(/"/g, '""')}"`;
}

function downloadCsv(filename: string, headers: string[], rows: unknown[][]) {
  const contents = [headers.map(csvCell).join(","), ...rows.map((row) => row.map(csvCell).join(","))].join("\n");
  const blob = new Blob([contents], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function DashboardLoadingNotice({ message }: { message: string | null }) {
  if (!message) {
    return null;
  }

  return <p className="warning-banner">{message}</p>;
}

export function DashboardPage() {
  const { token, user } = useAuth();
  const canManageBotData = isSystemAdminRole(user?.role);
  const [summary, setSummary] = useState<OperationsSummary>(emptySummary);
  const [appointments, setAppointments] = useState<OperationsAppointment[]>([]);
  const [clients, setClients] = useState<OperationsClient[]>([]);
  const [diagnostics, setDiagnostics] = useState<BotDiagnosticsResponse | null>(null);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [settings, setSettings] = useState<UserSettings>(emptySettings);
  const [activeTab, setActiveTab] = useState<DashboardTab>("overview");
  const [appointmentSearch, setAppointmentSearch] = useState("");
  const [appointmentStatusFilter, setAppointmentStatusFilter] = useState("all");
  const [appointmentWindowFilter, setAppointmentWindowFilter] = useState<"all" | "today" | "week" | "future">("all");
  const [clientSearch, setClientSearch] = useState("");
  const [stableReloadKey, setStableReloadKey] = useState(0);
  const [operationsReloadKey, setOperationsReloadKey] = useState(0);
  const [isStableLoading, setIsStableLoading] = useState(true);
  const [isOperationsLoading, setIsOperationsLoading] = useState(true);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [stableLoadError, setStableLoadError] = useState<string | null>(null);
  const [operationsLoadError, setOperationsLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [visibleAppointmentsCount, setVisibleAppointmentsCount] = useState(APPOINTMENTS_PAGE_SIZE);
  const [visibleClientsCount, setVisibleClientsCount] = useState(CLIENTS_PAGE_SIZE);

  const {
    status: botStatus,
    setStatus: setBotStatus,
    pollError: botStatusError,
  } = useDashboardBotStatus({
    token,
    initialStatus: diagnostics?.currentStatus ?? null,
    reloadKey: operationsReloadKey,
  });

  useEffect(() => {
    let active = true;

    async function loadStableData() {
      if (!token) {
        setIsStableLoading(false);
        return;
      }

      setIsStableLoading(true);
      setStableLoadError(null);

      const [clientsResult, settingsResult] = await Promise.allSettled([
        apiClient.getOperationsClients(token, { limit: 80 }),
        apiClient.getSettings(token),
      ]);

      if (!active) {
        return;
      }

      const errors: string[] = [];

      if (clientsResult.status === "fulfilled") {
        setClients(clientsResult.value.clients);
      } else {
        errors.push(getErrorMessage(clientsResult.reason, "Non riesco a caricare la rubrica clienti."));
      }

      if (settingsResult.status === "fulfilled") {
        setSettings(settingsResult.value);
      } else {
        errors.push(getErrorMessage(settingsResult.reason, "Non riesco a leggere le impostazioni del portale."));
      }

      setStableLoadError(errors.length > 0 ? errors.join(" ") : null);
      setIsStableLoading(false);
    }

    void loadStableData();

    return () => {
      active = false;
    };
  }, [stableReloadKey, token]);

  useEffect(() => {
    let active = true;

    async function loadOperationalData() {
      if (!token) {
        setIsOperationsLoading(false);
        return;
      }

      setIsOperationsLoading(true);
      setOperationsLoadError(null);

      const from = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
      const [summaryResult, appointmentsResult, diagnosticsResult, auditResult] = await Promise.allSettled([
        apiClient.getOperationsSummary(token),
        apiClient.getOperationsAppointments(token, { from, limit: 160 }),
        apiClient.getBotDiagnostics(token, 24),
        canManageBotData ? apiClient.getAuditEvents(token, 18) : Promise.resolve({ events: [] }),
      ]);

      if (!active) {
        return;
      }

      const errors: string[] = [];

      if (summaryResult.status === "fulfilled") {
        setSummary(summaryResult.value);
      } else {
        errors.push(getErrorMessage(summaryResult.reason, "Non riesco a leggere il riepilogo operativo."));
      }

      if (appointmentsResult.status === "fulfilled") {
        setAppointments(appointmentsResult.value.appointments);
      } else {
        errors.push(getErrorMessage(appointmentsResult.reason, "Non riesco a caricare le prenotazioni."));
      }

      if (diagnosticsResult.status === "fulfilled") {
        setDiagnostics(diagnosticsResult.value);
      } else {
        errors.push(getErrorMessage(diagnosticsResult.reason, "Non riesco a leggere la diagnostica di WhatsApp."));
      }

      if (auditResult.status === "fulfilled") {
        setAuditEvents(auditResult.value.events);
      } else {
        errors.push(getErrorMessage(auditResult.reason, "Non riesco a leggere gli ultimi eventi del portale."));
      }

      setOperationsLoadError(errors.length > 0 ? errors.join(" ") : null);
      setIsOperationsLoading(false);
    }

    void loadOperationalData();

    return () => {
      active = false;
    };
  }, [canManageBotData, operationsReloadKey, token]);

  useEffect(() => {
    setVisibleAppointmentsCount(APPOINTMENTS_PAGE_SIZE);
  }, [appointmentSearch, appointmentStatusFilter, appointmentWindowFilter]);

  useEffect(() => {
    setVisibleClientsCount(CLIENTS_PAGE_SIZE);
  }, [clientSearch]);

  useEffect(() => {
    if (!successMessage) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setSuccessMessage(null);
    }, 3000);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [successMessage]);

  function handleFullRefresh() {
    setActionError(null);
    setStableReloadKey((current) => current + 1);
    setOperationsReloadKey((current) => current + 1);
  }

  async function handleDisconnect() {
    if (!token) {
      return;
    }

    setIsDisconnecting(true);
    setActionError(null);
    setSuccessMessage(null);

    try {
      const nextStatus = await apiClient.disconnectBot(token);
      setBotStatus(nextStatus);
      setSuccessMessage("WhatsApp disconnesso correttamente.");
      setOperationsReloadKey((current) => current + 1);
    } catch (disconnectError) {
      setActionError(getErrorMessage(disconnectError, "Non sono riuscito a scollegare WhatsApp."));
    } finally {
      setIsDisconnecting(false);
    }
  }

  const isLoading = isStableLoading || isOperationsLoading;
  const botEvents = diagnostics?.events ?? [];
  const now = new Date();
  const oneWeekAhead = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const appointmentQuery = appointmentSearch.trim().toLowerCase();
  const clientQuery = clientSearch.trim().toLowerCase();
  const sortedAppointments = [...appointments].sort(
    (left, right) => new Date(left.startTime).getTime() - new Date(right.startTime).getTime(),
  );
  const activeAppointments = sortedAppointments.filter((appointment) => appointment.status !== "cancelled");
  const futureAppointments = activeAppointments.filter((appointment) => new Date(appointment.startTime) >= now);
  const todayAppointments = activeAppointments.filter((appointment) => sameDay(new Date(appointment.startTime), now));
  const waitingAppointments = activeAppointments.filter((appointment) => appointment.status === "pending");
  const bookedThisWeek = activeAppointments.filter((appointment) => {
    const start = new Date(appointment.startTime);
    return start >= now && start <= oneWeekAhead;
  });

  const recentFeedItems: Array<FeedItem & { createdAt: string }> = [
    ...botEvents.slice(0, 6).map((event) => ({
      id: `bot-${event.id}`,
      label: event.message,
      meta: `${new Date(event.createdAt).toLocaleString("it-IT")} - ${event.code}`,
      tone: eventTone(event.level),
      type: "WhatsApp",
      createdAt: event.createdAt,
    })),
    ...auditEvents.slice(0, 6).map((event) => ({
      id: `audit-${event.id}`,
      label: event.summary,
      meta: `${new Date(event.createdAt).toLocaleString("it-IT")} - ${event.actorEmail ?? "portale"}`,
      tone: "neutral" as const,
      type: "Portale",
      createdAt: event.createdAt,
    })),
  ];
  const recentFeed: FeedItem[] = recentFeedItems
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
    .map(({ createdAt: _createdAt, ...item }) => item);

  const calendarBuckets: DayBucket[] = Array.from({ length: 7 }, (_, index) => {
    const day = new Date(now);
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() + index);

    const nextDay = new Date(day);
    nextDay.setDate(nextDay.getDate() + 1);

    return {
      key: day.toISOString(),
      label: formatDateLong(day),
      items: futureAppointments.filter((appointment) => {
        const start = new Date(appointment.startTime);
        return start >= day && start < nextDay;
      }),
    };
  });

  const filteredAppointments = sortedAppointments.filter((appointment) => {
    const start = new Date(appointment.startTime);
    const matchesQuery =
      !appointmentQuery ||
      appointment.clientName.toLowerCase().includes(appointmentQuery) ||
      appointment.professionalName.toLowerCase().includes(appointmentQuery) ||
      appointment.serviceNames.join(" ").toLowerCase().includes(appointmentQuery) ||
      (appointment.clientPhone ?? "").toLowerCase().includes(appointmentQuery) ||
      (appointment.clientWhatsapp ?? "").toLowerCase().includes(appointmentQuery);
    const matchesStatus = appointmentStatusFilter === "all" || appointment.status === appointmentStatusFilter;
    const matchesWindow =
      appointmentWindowFilter === "all" ||
      (appointmentWindowFilter === "today" && sameDay(start, now)) ||
      (appointmentWindowFilter === "week" && start >= now && start <= oneWeekAhead) ||
      (appointmentWindowFilter === "future" && start >= now);

    return matchesQuery && matchesStatus && matchesWindow;
  });

  const filteredClients = [...clients]
    .filter((client) => {
      if (!clientQuery) {
        return true;
      }

      return (
        client.fullName.toLowerCase().includes(clientQuery) ||
        client.contacts.some((contact) => contact.value.toLowerCase().includes(clientQuery))
      );
    })
    .sort((left, right) => right.appointmentsCount - left.appointmentsCount);

  const serviceCounts = new Map<string, number>();
  const professionalCounts = new Map<string, number>();
  const statusCounts = new Map<string, number>();
  const hourlyCounts = new Map<string, number>();

  activeAppointments.forEach((appointment) => {
    statusCounts.set(appointment.status, (statusCounts.get(appointment.status) ?? 0) + 1);
    professionalCounts.set(
      appointment.professionalName,
      (professionalCounts.get(appointment.professionalName) ?? 0) + 1,
    );

    appointment.serviceNames.forEach((service) => {
      serviceCounts.set(service, (serviceCounts.get(service) ?? 0) + 1);
    });

    const hourKey = new Date(appointment.startTime).toLocaleTimeString("it-IT", {
      hour: "2-digit",
      minute: "2-digit",
    });
    hourlyCounts.set(hourKey, (hourlyCounts.get(hourKey) ?? 0) + 1);
  });

  const topServices = rankedFromMap(serviceCounts).slice(0, 6);
  const professionalLoad = rankedFromMap(professionalCounts).slice(0, 6);
  const statusBreakdown = rankedFromMap(statusCounts);
  const hourlyLoad = rankedFromMap(hourlyCounts)
    .sort((left, right) => left.label.localeCompare(right.label))
    .slice(0, 8);
  const visibleAppointments = filteredAppointments.slice(0, visibleAppointmentsCount);
  const remainingAppointmentsCount = Math.max(0, filteredAppointments.length - visibleAppointments.length);
  const visibleClients = filteredClients.slice(0, visibleClientsCount);
  const remainingClientsCount = Math.max(0, filteredClients.length - visibleClients.length);
  const topServicesMaxCount = Math.max(...topServices.map((item) => item.count), 1);
  const professionalLoadMaxCount = Math.max(...professionalLoad.map((item) => item.count), 1);
  const topClients = filteredClients.slice(0, 6);
  const nextAppointment = futureAppointments[0] ?? null;
  const busiestDay = [...calendarBuckets].sort((left, right) => right.items.length - left.items.length)[0];

  const activeTabLoadingMessage =
    activeTab === "overview"
      ? isStableLoading && isOperationsLoading
        ? "Sto aggiornando dashboard, clienti e stato operativo."
        : isOperationsLoading
          ? "Sto aggiornando appuntamenti, WhatsApp e segnali operativi."
          : isStableLoading
            ? "Sto aggiornando clienti e impostazioni del portale."
            : null
      : activeTab === "clients"
        ? isStableLoading
          ? "Sto aggiornando la rubrica clienti."
          : null
        : activeTab === "tools"
          ? null
          : isOperationsLoading
            ? "Sto aggiornando i dati operativi di questa sezione."
            : null;

  const attentionCards: AttentionCard[] = [
    {
      title: "WhatsApp",
      body:
        botStatus?.status === "connected"
          ? "Il collegamento e attivo e la sessione sembra utilizzabile."
          : "Conviene controllare il collegamento prima di iniziare la giornata.",
      tone: botStatus?.status === "connected" ? "success" : "warning",
    },
    {
      title: "Prenotazioni in attesa",
      body:
        waitingAppointments.length > 0
          ? `${waitingAppointments.length} prenotazioni aspettano ancora una conferma.`
          : "Non ci sono richieste in attesa da smaltire.",
      tone: waitingAppointments.length > 0 ? "warning" : "success",
    },
    {
      title: "Chat attive",
      body:
        summary.activeChatSessions > 0
          ? `${summary.activeChatSessions} conversazioni recenti da seguire.`
          : "In questo momento non risultano chat calde.",
      tone: summary.activeChatSessions > 0 ? "neutral" : "success",
    },
  ];

  const accountLabel = settings.displayName || user?.displayName || user?.email || "Account";
  const accountMeta = `Fuso ${settings.timezone} - lingua ${settings.locale} - accesso ${connectionModeLabel(settings.preferredConnectionMode)}`;

  function exportAppointmentsCsv() {
    downloadCsv(
      "dashboard-prenotazioni.csv",
      ["Quando", "Stato", "Cliente", "Telefono", "Professionista", "Servizi", "Durata", "Conferma", "Recensione"],
      filteredAppointments.map((appointment) => [
        appointmentWindow(appointment),
        appointment.status,
        appointment.clientName,
        appointment.clientPhone ?? appointment.clientWhatsapp ?? "",
        appointment.professionalName,
        appointment.serviceNames.join(" | "),
        `${appointment.serviceDurationMin} min`,
        appointment.confirmAskedAt ? new Date(appointment.confirmAskedAt).toLocaleString("it-IT") : "",
        appointment.reviewAskedAt ? new Date(appointment.reviewAskedAt).toLocaleString("it-IT") : "",
      ]),
    );
  }

  function exportClientsCsv() {
    downloadCsv(
      "dashboard-clienti.csv",
      ["Cliente", "Contatti", "Appuntamenti", "Ultimo appuntamento", "Prossimo appuntamento", "Ultima chat"],
      filteredClients.map((client) => [
        client.fullName,
        client.contacts.map((contact) => `${contact.type}: ${contact.value}`).join(" | "),
        client.appointmentsCount,
        client.lastAppointmentAt ? new Date(client.lastAppointmentAt).toLocaleString("it-IT") : "",
        client.nextAppointmentAt ? new Date(client.nextAppointmentAt).toLocaleString("it-IT") : "",
        client.lastChatAt ? new Date(client.lastChatAt).toLocaleString("it-IT") : "",
      ]),
    );
  }

  function renderActiveSection() {
    switch (activeTab) {
      case "overview":
        return (
          <OverviewSection
            accountLabel={accountLabel}
            accountMeta={accountMeta}
            attentionCards={attentionCards}
            busiestDay={busiestDay}
            isOperationsLoading={isOperationsLoading}
            nextAppointment={nextAppointment}
            recentFeed={recentFeed}
          />
        );
      case "calendar":
        return (
          <CalendarSection
            calendarBuckets={calendarBuckets}
            futureAppointmentsCount={futureAppointments.length}
            todayAppointments={todayAppointments}
          />
        );
      case "appointments":
        return (
          <AppointmentsSection
            appointmentSearch={appointmentSearch}
            appointmentStatusFilter={appointmentStatusFilter}
            appointmentWindowFilter={appointmentWindowFilter}
            filteredAppointmentsCount={filteredAppointments.length}
            onAppointmentSearchChange={setAppointmentSearch}
            onAppointmentStatusFilterChange={setAppointmentStatusFilter}
            onAppointmentWindowFilterChange={setAppointmentWindowFilter}
            onExportAppointments={exportAppointmentsCsv}
            onShowMoreAppointments={() =>
              setVisibleAppointmentsCount((current) => current + APPOINTMENTS_PAGE_SIZE)
            }
            remainingAppointmentsCount={remainingAppointmentsCount}
            visibleAppointments={visibleAppointments}
          />
        );
      case "clients":
        return (
          <ClientsSection
            clientSearch={clientSearch}
            filteredClientsCount={filteredClients.length}
            onClientSearchChange={setClientSearch}
            onExportClients={exportClientsCsv}
            onShowMoreClients={() => setVisibleClientsCount((current) => current + CLIENTS_PAGE_SIZE)}
            remainingClientsCount={remainingClientsCount}
            visibleClients={visibleClients}
          />
        );
      case "whatsapp":
        return (
          <WhatsAppSection
            botEvents={botEvents}
            botStatus={botStatus}
            botStatusError={botStatusError}
            isDisconnecting={isDisconnecting}
            notificationsEnabled={settings.notificationsEnabled}
            onDisconnect={handleDisconnect}
            preferredConnectionMode={settings.preferredConnectionMode}
          />
        );
      case "analytics":
        return (
          <AnalyticsSection
            hourlyLoad={hourlyLoad}
            professionalLoad={professionalLoad}
            professionalLoadMaxCount={professionalLoadMaxCount}
            statusBreakdown={statusBreakdown}
            topClients={topClients}
            topServices={topServices}
            topServicesMaxCount={topServicesMaxCount}
          />
        );
      case "tools":
        return <ToolsSection canManageBotData={canManageBotData} />;
      default:
        return null;
    }
  }

  return (
    <div className="page-stack dashboard-workbench">
      <section className="hero-card dashboard-hero">
        <div className="dashboard-hero-copy">
          <p className="eyebrow">Centro operativo</p>
          <h2>Agenda, clienti e WhatsApp nella stessa vista di lavoro del salone.</h2>
          <p className="muted">
            Controlli rapidi su appuntamenti, conversazioni e segnali della giornata, con dati operativi aggiornati
            senza dover saltare tra moduli diversi.
          </p>
        </div>

        <div className="dashboard-hero-actions">
          <button disabled={isLoading} onClick={handleFullRefresh} type="button">
            {isLoading ? "Aggiorno dashboard..." : "Aggiorna dati"}
          </button>
          <Link className="inline-action" to="/operations">
            Apri agenda completa
          </Link>
          <Link className="inline-action dashboard-secondary-link" to="/connect">
            Controlla WhatsApp
          </Link>
        </div>
      </section>

      {successMessage ? <p className="success-banner">{successMessage}</p> : null}
      {actionError ? <p className="error-banner">{actionError}</p> : null}
      {stableLoadError ? <p className="error-banner">{stableLoadError}</p> : null}
      {operationsLoadError ? <p className="error-banner">{operationsLoadError}</p> : null}

      <section className="dashboard-strip">
        <article className="metric-card">
          <span className="metric-label">WhatsApp</span>
          <strong>{botStatusLabel(botStatus?.status)}</strong>
          <p>{botStatus?.phoneNumber ?? settings.phoneNumber ?? "Nessun numero visibile"}</p>
        </article>
        <article className="metric-card">
          <span className="metric-label">Appuntamenti oggi</span>
          <strong>{summary.todayAppointments}</strong>
          <p>{todayAppointments.length} nell'elenco caricato e pronti da lavorare.</p>
        </article>
        <article className="metric-card">
          <span className="metric-label">In arrivo</span>
          <strong>{summary.upcomingAppointments}</strong>
          <p>{bookedThisWeek.length} cadono nei prossimi sette giorni.</p>
        </article>
        <article className="metric-card">
          <span className="metric-label">Clienti</span>
          <strong>{summary.totalClients}</strong>
          <p>{filteredClients.length} visibili nella rubrica caricata.</p>
        </article>
        <article className="metric-card">
          <span className="metric-label">Operatori attivi</span>
          <strong>{summary.activeProfessionals}</strong>
          <p>Professionisti che risultano operativi nel sistema.</p>
        </article>
        <article className="metric-card">
          <span className="metric-label">Chat vive</span>
          <strong>{summary.activeChatSessions}</strong>
          <p>Conversazioni recenti ancora da seguire.</p>
        </article>
      </section>

      <section className="card dashboard-tabs-card">
        <div className="dashboard-tabs" role="tablist" aria-label="Sezioni dashboard">
          {dashboardTabs.map((tab) => (
            <button
              aria-selected={activeTab === tab.id}
              className={`dashboard-tab ${activeTab === tab.id ? "active" : ""}`}
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              role="tab"
              type="button"
            >
              <span>{tab.label}</span>
              <small>{tab.hint}</small>
            </button>
          ))}
        </div>
      </section>

      <DashboardLoadingNotice message={activeTabLoadingMessage} />

      {renderActiveSection()}
    </div>
  );
}
