import type { OperationsClient } from "@whatsapp-ai/shared";

import type { RankedMetric } from "../dashboardView";
import { appointmentStatusLabel, appointmentStatusTone, formatDateTime } from "../dashboardView";

type AnalyticsSectionProps = {
  hourlyLoad: RankedMetric[];
  professionalLoad: RankedMetric[];
  professionalLoadMaxCount: number;
  statusBreakdown: RankedMetric[];
  topClients: OperationsClient[];
  topServices: RankedMetric[];
  topServicesMaxCount: number;
};

export function AnalyticsSection({
  hourlyLoad,
  professionalLoad,
  professionalLoadMaxCount,
  statusBreakdown,
  topClients,
  topServices,
  topServicesMaxCount,
}: AnalyticsSectionProps) {
  return (
    <div className="dashboard-panel-grid">
      <section className="card">
        <div className="card-heading">
          <div>
            <p className="eyebrow">Trend operativi</p>
            <h3>Dove si concentra il lavoro</h3>
          </div>
        </div>

        <div className="dashboard-report-grid">
          <article className="dashboard-report-card">
            <h4>Servizi piu richiesti</h4>
            <div className="dashboard-bar-list">
              {topServices.length === 0 ? (
                <p className="muted">Non ci sono ancora dati sufficienti.</p>
              ) : (
                topServices.map((item) => (
                  <div className="dashboard-bar-row" key={item.label}>
                    <div>
                      <strong>{item.label}</strong>
                      <small>{item.count} prenotazioni</small>
                    </div>
                    <span style={{ width: `${Math.round((item.count / topServicesMaxCount) * 100)}%` }} />
                  </div>
                ))
              )}
            </div>
          </article>

          <article className="dashboard-report-card">
            <h4>Carico per professionista</h4>
            <div className="dashboard-bar-list">
              {professionalLoad.length === 0 ? (
                <p className="muted">Nessun professionista trovato nel dataset.</p>
              ) : (
                professionalLoad.map((item) => (
                  <div className="dashboard-bar-row" key={item.label}>
                    <div>
                      <strong>{item.label}</strong>
                      <small>{item.count} appuntamenti</small>
                    </div>
                    <span style={{ width: `${Math.round((item.count / professionalLoadMaxCount) * 100)}%` }} />
                  </div>
                ))
              )}
            </div>
          </article>

          <article className="dashboard-report-card">
            <h4>Stati prenotazioni</h4>
            <div className="dashboard-stat-list">
              {statusBreakdown.length === 0 ? (
                <p className="muted">Nessun dato sugli stati.</p>
              ) : (
                statusBreakdown.map((item) => (
                  <div className={`dashboard-stat-row tone-${appointmentStatusTone(item.label)}`} key={item.label}>
                    <span>{appointmentStatusLabel(item.label)}</span>
                    <strong>{item.count}</strong>
                  </div>
                ))
              )}
            </div>
          </article>

          <article className="dashboard-report-card">
            <h4>Fasce orarie piu piene</h4>
            <div className="dashboard-stat-list">
              {hourlyLoad.length === 0 ? (
                <p className="muted">Non ci sono ancora fasce orarie da confrontare.</p>
              ) : (
                hourlyLoad.map((item) => (
                  <div className="dashboard-stat-row tone-neutral" key={item.label}>
                    <span>{item.label}</span>
                    <strong>{item.count}</strong>
                  </div>
                ))
              )}
            </div>
          </article>
        </div>
      </section>

      <section className="card">
        <div className="card-heading">
          <div>
            <p className="eyebrow">Clienti forti</p>
            <h3>Chi appare piu spesso</h3>
          </div>
        </div>

        {topClients.length === 0 ? (
          <div className="db-empty">Non risultano clienti da evidenziare.</div>
        ) : (
          <div className="dashboard-feed-list">
            {topClients.map((client) => (
              <article className="dashboard-feed-item" key={client.clientId}>
                <div>
                  <strong>{client.fullName}</strong>
                  <p className="muted">
                    {client.appointmentsCount} appuntamenti · {client.contacts.length} contatti · prossimo{" "}
                    {formatDateTime(client.nextAppointmentAt)}
                  </p>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
