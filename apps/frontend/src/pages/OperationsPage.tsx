import { useEffect, useState } from "react";

import type {
  OperationsAppointment,
  OperationsClient,
  OperationsSummary,
} from "@whatsapp-ai/shared";

import { useAuth } from "../auth/useAuth";
import { apiClient, getErrorMessage } from "../lib/api";

const emptySummary: OperationsSummary = {
  totalClients: 0,
  upcomingAppointments: 0,
  todayAppointments: 0,
  activeHolds: 0,
  activeChatSessions: 0,
  activeProfessionals: 0,
};

function formatDateTime(value: string | null) {
  return value ? new Date(value).toLocaleString("it-IT") : "Nessun dato";
}

function formatContactType(type: string) {
  switch (type.toLowerCase()) {
    case "phone":
      return "Telefono";
    case "whatsapp_chat":
      return "WhatsApp";
    default:
      return type;
  }
}

function formatAppointmentWindow(appointment: OperationsAppointment) {
  const start = new Date(appointment.startTime);
  const end = new Date(appointment.endTime);
  return `${start.toLocaleString("it-IT")} - ${end.toLocaleTimeString("it-IT", {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

export function OperationsPage() {
  const { token } = useAuth();
  const [summary, setSummary] = useState<OperationsSummary>(emptySummary);
  const [appointments, setAppointments] = useState<OperationsAppointment[]>([]);
  const [clients, setClients] = useState<OperationsClient[]>([]);
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function loadOperations() {
      if (!token) {
        return;
      }

      setIsLoading(true);
      setError(null);

      try {
        const [nextSummary, nextAppointments, nextClients] = await Promise.all([
          apiClient.getOperationsSummary(token),
          apiClient.getOperationsAppointments(token, {
            limit: 30,
            search,
            status: status || null,
          }),
          apiClient.getOperationsClients(token, {
            limit: 30,
            search,
          }),
        ]);

        if (!active) {
          return;
        }

        setSummary(nextSummary);
        setAppointments(nextAppointments.appointments);
        setClients(nextClients.clients);
      } catch (loadError) {
        if (active) {
          setError(getErrorMessage(loadError, "Non riesco a caricare clienti e appuntamenti."));
        }
      } finally {
        if (active) {
          setIsLoading(false);
        }
      }
    }

    void loadOperations();

    return () => {
      active = false;
    };
  }, [search, status, token]);

  return (
    <div className="page-stack">
      <section className="hero-card">
        <p className="eyebrow">Lavoro di oggi</p>
        <h2>Clienti e appuntamenti in una vista chiara.</h2>
        <p className="muted">
          Questa pagina raccoglie le informazioni più utili per lavorare: clienti, contatti, appuntamenti e attività
          recenti.
        </p>

        <div className="hero-metrics">
          <article className="metric-card">
            <span className="metric-label">Clienti</span>
            <strong>{summary.totalClients}</strong>
            <p>Quante persone sono già registrate.</p>
          </article>
          <article className="metric-card">
            <span className="metric-label">Appuntamenti in arrivo</span>
            <strong>{summary.upcomingAppointments}</strong>
            <p>Gli impegni da seguire nei prossimi giorni.</p>
          </article>
          <article className="metric-card">
            <span className="metric-label">Appuntamenti di oggi</span>
            <strong>{summary.todayAppointments}</strong>
            <p>Una vista veloce sul carico della giornata.</p>
          </article>
          <article className="metric-card">
            <span className="metric-label">Posti bloccati</span>
            <strong>{summary.activeHolds}</strong>
            <p>Richieste in sospeso da tenere d'occhio.</p>
          </article>
          <article className="metric-card">
            <span className="metric-label">Chat recenti</span>
            <strong>{summary.activeChatSessions}</strong>
            <p>Conversazioni ancora vive con i clienti.</p>
          </article>
          <article className="metric-card">
            <span className="metric-label">Operatori attivi</span>
            <strong>{summary.activeProfessionals}</strong>
            <p>Professionisti oggi disponibili nel sistema.</p>
          </article>
        </div>
      </section>

      <section className="card">
        <div className="card-heading">
          <div>
            <p className="eyebrow">Ricerca</p>
            <h3>Trova subito quello che ti serve</h3>
          </div>
        </div>

        <form
          className="toolbar-grid"
          onSubmit={(event) => {
            event.preventDefault();
            setSearch(searchDraft.trim());
          }}
        >
          <label>
            Cerca per nome, numero, operatore o servizio
            <input
              onChange={(event) => setSearchDraft(event.target.value)}
              placeholder="Es. Giulia, refill, 333..."
              type="search"
              value={searchDraft}
            />
          </label>

          <label>
            Stato appuntamento
            <select onChange={(event) => setStatus(event.target.value)} value={status}>
              <option value="">Tutti</option>
              <option value="confirmed">Confermato</option>
              <option value="pending">In attesa</option>
              <option value="cancelled">Annullato</option>
            </select>
          </label>

          <div className="action-row">
            <button disabled={isLoading} type="submit">
              {isLoading ? "Aggiorno..." : "Cerca"}
            </button>
            <button
              className="ghost-button"
              onClick={() => {
                setSearchDraft("");
                setSearch("");
                setStatus("");
              }}
              type="button"
            >
              Pulisci
            </button>
          </div>
        </form>
      </section>

      {error ? <p className="error-banner">{error}</p> : null}

      <section className="card">
        <div className="card-heading">
          <div>
            <p className="eyebrow">Appuntamenti</p>
            <h3>Agenda</h3>
          </div>
          <p className="muted">{appointments.length} appuntamenti mostrati</p>
        </div>

        {isLoading ? (
          <div className="db-empty">Sto caricando gli appuntamenti...</div>
        ) : appointments.length === 0 ? (
          <div className="db-empty">Non ci sono appuntamenti che corrispondono ai filtri scelti.</div>
        ) : (
          <div className="db-browser-table-wrap">
            <table className="db-browser-table">
              <thead>
                <tr>
                  <th>Quando</th>
                  <th>Stato</th>
                  <th>Cliente</th>
                  <th>Operatore</th>
                  <th>Servizi</th>
                  <th>Messaggi inviati</th>
                </tr>
              </thead>
              <tbody>
                {appointments.map((appointment) => (
                  <tr key={appointment.appointmentId}>
                    <td>
                      <strong>{formatAppointmentWindow(appointment)}</strong>
                      <div className="table-subline">
                        {appointment.clientPhone ?? appointment.clientWhatsapp ?? "Contatto non trovato"}
                      </div>
                    </td>
                    <td>{appointment.status}</td>
                    <td>{appointment.clientName}</td>
                    <td>{appointment.professionalName}</td>
                    <td>
                      <div>{appointment.serviceNames.join(", ") || "Nessun servizio"}</div>
                      <div className="table-subline">{appointment.serviceDurationMin} min</div>
                    </td>
                    <td>
                      <div>Conferma: {formatDateTime(appointment.confirmAskedAt)}</div>
                      <div className="table-subline">Recensione: {formatDateTime(appointment.reviewAskedAt)}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-heading">
          <div>
            <p className="eyebrow">Clienti</p>
            <h3>Rubrica</h3>
          </div>
          <p className="muted">{clients.length} clienti mostrati</p>
        </div>

        {isLoading ? (
          <div className="db-empty">Sto caricando i clienti...</div>
        ) : clients.length === 0 ? (
          <div className="db-empty">Non ci sono clienti che corrispondono ai filtri scelti.</div>
        ) : (
          <div className="stacked-list">
            {clients.map((client) => (
              <article className="stacked-item" key={client.clientId}>
                <div className="stacked-item-head">
                  <div>
                    <strong>{client.fullName}</strong>
                    <p className="muted">
                      Cliente #{client.clientId} - Appuntamenti: {client.appointmentsCount} - Ultima chat:{" "}
                      {formatDateTime(client.lastChatAt)}
                    </p>
                  </div>
                </div>

                <div className="field-chips">
                  {client.contacts.length > 0 ? (
                    client.contacts.map((contact) => (
                      <span className="field-chip" key={`${client.clientId}-${contact.type}-${contact.value}`}>
                        {formatContactType(contact.type)}: {contact.value}
                      </span>
                    ))
                  ) : (
                    <span className="field-chip">Nessun contatto registrato</span>
                  )}
                </div>

                <div className="details-grid compact-grid">
                  <div>
                    <dt>Ultimo appuntamento</dt>
                    <dd>{formatDateTime(client.lastAppointmentAt)}</dd>
                  </div>
                  <div>
                    <dt>Prossimo appuntamento</dt>
                    <dd>{formatDateTime(client.nextAppointmentAt)}</dd>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
