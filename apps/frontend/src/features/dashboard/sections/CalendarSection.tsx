import type { OperationsAppointment } from "@whatsapp-ai/shared";

import type { DayBucket } from "../dashboardView";
import { appointmentStatusLabel, formatTime } from "../dashboardView";

type CalendarSectionProps = {
  calendarBuckets: DayBucket[];
  futureAppointmentsCount: number;
  todayAppointments: OperationsAppointment[];
};

export function CalendarSection({
  calendarBuckets,
  futureAppointmentsCount,
  todayAppointments,
}: CalendarSectionProps) {
  return (
    <div className="dashboard-panel-grid">
      <section className="card">
        <div className="card-heading">
          <div>
            <p className="eyebrow">Agenda settimanale</p>
            <h3>I prossimi sette giorni</h3>
          </div>
          <p className="muted">{futureAppointmentsCount} appuntamenti futuri nell'elenco caricato</p>
        </div>

        <div className="dashboard-calendar-grid">
          {calendarBuckets.map((bucket) => (
            <article className="dashboard-day-card" key={bucket.key}>
              <header>
                <strong>{bucket.label}</strong>
                <small className="muted">
                  {bucket.items.length === 0 ? "Nessun appuntamento" : `${bucket.items.length} appuntamenti`}
                </small>
              </header>
              {bucket.items.length === 0 ? (
                <p className="muted">Nessun appuntamento.</p>
              ) : (
                <div className="dashboard-day-list">
                  {bucket.items.map((appointment) => (
                    <article className="dashboard-day-item" key={appointment.appointmentId}>
                      <div className="dashboard-day-item-head">
                        <strong>{formatTime(appointment.startTime)}</strong>
                        <span className={`status-pill status-${appointment.status}`}>
                          {appointmentStatusLabel(appointment.status)}
                        </span>
                      </div>
                      <p>{appointment.clientName}</p>
                      <small>
                        {appointment.serviceNames.join(", ")} · {appointment.professionalName}
                      </small>
                    </article>
                  ))}
                </div>
              )}
            </article>
          ))}
        </div>
      </section>

      <section className="card">
        <div className="card-heading">
          <div>
            <p className="eyebrow">Oggi</p>
            <h3>Sequenza della giornata</h3>
          </div>
        </div>

        {todayAppointments.length === 0 ? (
          <div className="db-empty">Oggi non risultano appuntamenti nell'elenco disponibile.</div>
        ) : (
          <div className="dashboard-feed-list">
            {todayAppointments.map((appointment) => (
              <article className="dashboard-feed-item" key={appointment.appointmentId}>
                <div>
                  <strong>{appointment.clientName}</strong>
                  <p className="muted">
                    {formatTime(appointment.startTime)} · {appointment.serviceNames.join(", ")} ·{" "}
                    {appointment.professionalName}
                  </p>
                </div>
                <span className={`status-pill status-${appointment.status}`}>
                  {appointmentStatusLabel(appointment.status)}
                </span>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
