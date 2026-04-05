import React, { type ReactNode } from "react";

type ErrorBoundaryProps = {
  children: ReactNode;
};

type ErrorBoundaryState = {
  hasError: boolean;
};

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    hasError: false,
  };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    console.error("[frontend] uncaught render error", error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <section className="card">
          <p className="eyebrow">Errore interfaccia</p>
          <h2>Qualcosa è andato storto</h2>
          <p className="error-banner">
            Questa sezione del portale ha avuto un problema inatteso. Ricarica la pagina per riprendere il lavoro.
          </p>
          <div className="action-row">
            <button onClick={() => window.location.reload()} type="button">
              Ricarica pagina
            </button>
          </div>
        </section>
      );
    }

    return this.props.children;
  }
}
