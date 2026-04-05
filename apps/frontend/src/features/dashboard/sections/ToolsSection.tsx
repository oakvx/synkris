import { Link } from "react-router-dom";

type ToolsSectionProps = {
  canManageBotData: boolean;
};

const pendingModules = [
  {
    title: "Coupon e promozioni",
    description: "La sezione e predisposta a livello di UX, ma in questo repo non esiste ancora l'API dedicata.",
  },
  {
    title: "Lista d'attesa",
    description: "Puoi innestarla bene qui quando avremo endpoint o modello dati per le richieste in sospeso.",
  },
  {
    title: "Magazzino",
    description: "Ottimo candidato per un modulo separato con inventario, soglie e fornitori.",
  },
  {
    title: "Promemoria avanzati",
    description: "Possiamo collegarlo piu avanti a regole automatiche e template WhatsApp.",
  },
] as const;

export function ToolsSection({ canManageBotData }: ToolsSectionProps) {
  return (
    <div className="dashboard-panel-grid">
      <section className="card">
        <div className="card-heading">
          <div>
            <p className="eyebrow">Azioni rapide</p>
            <h3>Moduli gia disponibili nel progetto</h3>
          </div>
        </div>

        <div className="timeline-grid">
          <article className="action-panel">
            <strong>Clienti e appuntamenti</strong>
            <p>Vista dettagliata per lavorare con agenda, clienti e stato dei messaggi.</p>
            <Link className="inline-action" to="/operations">
              Apri modulo
            </Link>
          </article>
          <article className="action-panel">
            <strong>Collega WhatsApp</strong>
            <p>QR, codice di pairing e riavvio del collegamento.</p>
            <Link className="inline-action" to="/connect">
              Apri modulo
            </Link>
          </article>
          <article className="action-panel">
            <strong>Storico</strong>
            <p>Feed diagnostico, audit log e ultimi eventi del bot.</p>
            <Link className="inline-action" to="/activity">
              Apri modulo
            </Link>
          </article>
          <article className="action-panel">
            <strong>Impostazioni</strong>
            <p>Preferenze account, numero e metodo preferito di accesso.</p>
            <Link className="inline-action" to="/settings">
              Apri modulo
            </Link>
          </article>
          {canManageBotData ? (
            <article className="action-panel">
              <strong>Area tecnica</strong>
              <p>Database browser, SQL e controlli avanzati per l'amministratore.</p>
              <Link className="inline-action" to="/database">
                Apri modulo
              </Link>
            </article>
          ) : null}
        </div>
      </section>

      <section className="card">
        <div className="card-heading">
          <div>
            <p className="eyebrow">Moduli da collegare</p>
            <h3>Blocchi previsti dalla dashboard PHP</h3>
          </div>
        </div>

        <div className="dashboard-module-grid">
          {pendingModules.map((module) => (
            <article className="dashboard-module-card" key={module.title}>
              <strong>{module.title}</strong>
              <p>{module.description}</p>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
