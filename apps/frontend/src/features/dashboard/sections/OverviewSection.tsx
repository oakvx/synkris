import { Link } from "react-router-dom";

import type { OperationsAppointment } from "@whatsapp-ai/shared";

import type { AttentionCard, DayBucket, FeedItem } from "../dashboardView";
import { appointmentWindow, formatDateLabel } from "../dashboardView";

type OverviewSectionProps = {
  attentionCards: AttentionCard[];
  accountLabel: string;
  accountMeta: string;
  busiestDay: DayBucket | undefined;
  isOperationsLoading: boolean;
  nextAppointment: OperationsAppointment | null;
  recentFeed: FeedItem[];
};

export function OverviewSection({
  attentionCards,
  accountLabel,
  accountMeta,
  busiestDay,
  isOperationsLoading,
  nextAppointment,
  recentFeed,
}: OverviewSectionProps) {
  return (
    <div className="dashboard-panel-grid">
      <section className="card">
        <div className="card-heading">
          <div>
            <p className="eyebrow">Focus del giorno</p>
            <h3>Cosa merita attenzione adesso</h3>
          </div>
        </div>

        <div className="dashboard-focus-grid">
          <article className="dashboard-focus-card">
            <span className="metric-label">Prossimo appuntamento</span>
            <strong>{nextAppointment ? nextAppointment.clientName : "Agenda libera"}</strong>
            <p>
              {nextAppointment
                ? `${appointmentWindow(nextAppointment)} · ${nextAppointment.serviceNames.join(", ")}`
                : "Non ci sono appuntamenti futuri nel dataset caricato."}
            </p>
          </article>
          <article className="dashboard-focus-card">
            <span className="metric-label">Giorno piu carico</span>
            <strong>{busiestDay?.items.length ? formatDateLabel(new Date(busiestDay.key)) : "Nessun picco"}</strong>
            <p>
              {busiestDay?.items.length
                ? `${busiestDay.items.length} appuntamenti distribuiti nella giornata.`
                : "Nessun giorno risulta particolarmente carico nei prossimi sette giorni."}
            </p>
          </article>
          <article className="dashboard-focus-card">
            <span className="metric-label">Preferenze account</span>
            <strong>{accountLabel}</strong>
            <p>{accountMeta}</p>
          </article>
        </div>

        <div className="dashboard-signal-grid">
          {attentionCards.map((card) => (
            <article className={`dashboard-signal-card tone-${card.tone}`} key={card.title}>
              <strong>{card.title}</strong>
              <p>{card.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="card">
        <div className="card-heading">
          <div>
            <p className="eyebrow">Ultimi movimenti</p>
            <h3>Feed rapido</h3>
          </div>
          <Link className="inline-action dashboard-inline-link" to="/activity">
            Apri storico completo
          </Link>
        </div>

        {isOperationsLoading ? (
          <div className="db-empty">Sto caricando gli ultimi eventi...</div>
        ) : recentFeed.length === 0 ? (
          <div className="db-empty">Non ci sono ancora eventi recenti da mostrare.</div>
        ) : (
          <div className="dashboard-feed-list">
            {recentFeed.slice(0, 8).map((item) => (
              <article className={`dashboard-feed-item tone-${item.tone}`} key={item.id}>
                <div>
                  <strong>{item.label}</strong>
                  <p className="muted">
                    {item.type} · {item.meta}
                  </p>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-heading">
          <div>
            <p className="eyebrow">Collegamenti rapidi</p>
            <h3>Apri le viste complete</h3>
          </div>
        </div>

        <div className="timeline-grid">
          <article className="action-panel">
            <strong>Agenda operativa</strong>
            <p>Clienti, appuntamenti e messaggi in una schermata piu dettagliata.</p>
            <Link className="inline-action" to="/operations">
              Vai a clienti e appuntamenti
            </Link>
          </article>
          <article className="action-panel">
            <strong>Collegamento WhatsApp</strong>
            <p>QR, codice di pairing e verifica della sessione.</p>
            <Link className="inline-action" to="/connect">
              Vai a WhatsApp
            </Link>
          </article>
          <article className="action-panel">
            <strong>Storico e diagnostica</strong>
            <p>Eventi recenti, problemi e azioni importanti registrate dal portale.</p>
            <Link className="inline-action" to="/activity">
              Vai allo storico
            </Link>
          </article>
          <article className="action-panel">
            <strong>Impostazioni</strong>
            <p>Nome visualizzato, numero, fuso orario e preferenze usate dal portale.</p>
            <Link className="inline-action" to="/settings">
              Vai alle impostazioni
            </Link>
          </article>
        </div>
      </section>
    </div>
  );
}
