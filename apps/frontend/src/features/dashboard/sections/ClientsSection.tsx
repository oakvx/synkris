import { Link } from "react-router-dom";

import type { OperationsClient } from "@whatsapp-ai/shared";

import { formatDateTime } from "../dashboardView";

type ClientsSectionProps = {
  clientSearch: string;
  filteredClientsCount: number;
  onClientSearchChange: (value: string) => void;
  onExportClients: () => void;
  onShowMoreClients: () => void;
  remainingClientsCount: number;
  visibleClients: OperationsClient[];
};

export function ClientsSection({
  clientSearch,
  filteredClientsCount,
  onClientSearchChange,
  onExportClients,
  onShowMoreClients,
  remainingClientsCount,
  visibleClients,
}: ClientsSectionProps) {
  return (
    <div className="dashboard-panel-grid">
      <section className="card">
        <div className="card-heading">
          <div>
            <p className="eyebrow">Rubrica</p>
            <h3>Clienti piu rilevanti</h3>
            <p className="muted">
              Mostro {visibleClients.length} di {filteredClientsCount} clienti filtrati.
            </p>
          </div>
          <div className="action-row">
            <button onClick={onExportClients} type="button">
              Esporta CSV
            </button>
            <Link className="inline-action dashboard-inline-link" to="/operations">
              Apri sezione clienti
            </Link>
          </div>
        </div>

        <div className="toolbar-grid dashboard-toolbar dashboard-toolbar-simple">
          <label>
            Cerca cliente o contatto
            <input
              onChange={(event) => onClientSearchChange(event.target.value)}
              placeholder="Es. Marta o 39..."
              type="search"
              value={clientSearch}
            />
          </label>
        </div>

        {filteredClientsCount === 0 ? (
          <div className="db-empty">Non ci sono clienti che corrispondono alla ricerca.</div>
        ) : (
          <>
            <div className="stacked-list">
              {visibleClients.map((client) => (
                <article className="stacked-item" key={client.clientId}>
                  <div className="stacked-item-head">
                    <div>
                      <strong>{client.fullName}</strong>
                      <p className="muted">
                        Cliente #{client.clientId} · {client.appointmentsCount} appuntamenti · ultima chat{" "}
                        {formatDateTime(client.lastChatAt)}
                      </p>
                    </div>
                  </div>

                  <div className="field-chips">
                    {client.contacts.length > 0 ? (
                      client.contacts.map((contact) => (
                        <span className="field-chip" key={`${client.clientId}-${contact.type}-${contact.value}`}>
                          {contact.type}: {contact.value}
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
            {remainingClientsCount > 0 ? (
              <div className="action-row">
                <p className="muted">Restano nascosti {remainingClientsCount} clienti.</p>
                <button onClick={onShowMoreClients} type="button">
                  Mostra altri ({remainingClientsCount})
                </button>
              </div>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
