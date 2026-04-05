import { Link } from "react-router-dom";

import type { OperationsAppointment } from "@whatsapp-ai/shared";

import { appointmentStatusLabel, appointmentWindow } from "../dashboardView";

type AppointmentWindowFilter = "all" | "today" | "week" | "future";

type AppointmentsSectionProps = {
  appointmentSearch: string;
  appointmentStatusFilter: string;
  appointmentWindowFilter: AppointmentWindowFilter;
  filteredAppointmentsCount: number;
  onAppointmentSearchChange: (value: string) => void;
  onAppointmentStatusFilterChange: (value: string) => void;
  onAppointmentWindowFilterChange: (value: AppointmentWindowFilter) => void;
  onExportAppointments: () => void;
  onShowMoreAppointments: () => void;
  remainingAppointmentsCount: number;
  visibleAppointments: OperationsAppointment[];
};

export function AppointmentsSection({
  appointmentSearch,
  appointmentStatusFilter,
  appointmentWindowFilter,
  filteredAppointmentsCount,
  onAppointmentSearchChange,
  onAppointmentStatusFilterChange,
  onAppointmentWindowFilterChange,
  onExportAppointments,
  onShowMoreAppointments,
  remainingAppointmentsCount,
  visibleAppointments,
}: AppointmentsSectionProps) {
  return (
    <div className="dashboard-panel-grid">
      <section className="card">
        <div className="card-heading">
          <div>
            <p className="eyebrow">Filtri rapidi</p>
            <h3>Prenotazioni operative</h3>
            <p className="muted">
              Mostro {visibleAppointments.length} di {filteredAppointmentsCount} prenotazioni filtrate.
            </p>
          </div>
          <div className="action-row">
            <button onClick={onExportAppointments} type="button">
              Esporta CSV
            </button>
            <Link className="inline-action dashboard-inline-link" to="/operations">
              Apri vista completa
            </Link>
          </div>
        </div>

        <div className="toolbar-grid dashboard-toolbar">
          <label>
            Cerca cliente, servizio o numero
            <input
              onChange={(event) => onAppointmentSearchChange(event.target.value)}
              placeholder="Es. refill, Giulia, 333..."
              type="search"
              value={appointmentSearch}
            />
          </label>

          <label>
            Stato
            <select
              onChange={(event) => onAppointmentStatusFilterChange(event.target.value)}
              value={appointmentStatusFilter}
            >
              <option value="all">Tutti</option>
              <option value="confirmed">Confermati</option>
              <option value="pending">In attesa</option>
              <option value="completed">Completati</option>
              <option value="cancelled">Annullati</option>
            </select>
          </label>

          <label>
            Finestra
            <select
              onChange={(event) => onAppointmentWindowFilterChange(event.target.value as AppointmentWindowFilter)}
              value={appointmentWindowFilter}
            >
              <option value="all">Tutti</option>
              <option value="today">Solo oggi</option>
              <option value="week">Prossimi 7 giorni</option>
              <option value="future">Solo futuri</option>
            </select>
          </label>
        </div>

        {filteredAppointmentsCount === 0 ? (
          <div className="db-empty">I filtri attuali non mostrano prenotazioni.</div>
        ) : (
          <>
            <div className="dashboard-appointment-list">
              {visibleAppointments.map((appointment) => (
                <article className="dashboard-appointment-card" key={appointment.appointmentId}>
                  <div className="dashboard-appointment-head">
                    <div>
                      <strong>{appointment.clientName}</strong>
                      <p className="muted">{appointmentWindow(appointment)}</p>
                    </div>
                    <span className={`status-pill status-${appointment.status}`}>
                      {appointmentStatusLabel(appointment.status)}
                    </span>
                  </div>
                  <div className="dashboard-appointment-meta">
                    <span>{appointment.professionalName}</span>
                    <span>{appointment.serviceNames.join(", ") || "Nessun servizio"}</span>
                    <span>{appointment.serviceDurationMin} min</span>
                    <span>{appointment.clientPhone ?? appointment.clientWhatsapp ?? "Nessun contatto"}</span>
                  </div>
                </article>
              ))}
            </div>
            {remainingAppointmentsCount > 0 ? (
              <div className="action-row">
                <p className="muted">Restano nascoste {remainingAppointmentsCount} prenotazioni.</p>
                <button onClick={onShowMoreAppointments} type="button">
                  Mostra altri ({remainingAppointmentsCount})
                </button>
              </div>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
