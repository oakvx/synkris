import { useMemo, useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";

import { useAuth } from "../auth/useAuth";
import { apiClient, getErrorMessage } from "../lib/api";

export function LoginPage() {
  const showDevResetPreview = import.meta.env.DEV;
  const navigate = useNavigate();
  const { isLoading, login, register, token } = useAuth();
  const [searchParams] = useSearchParams();
  const initialResetToken = useMemo(() => searchParams.get("resetToken") ?? "", [searchParams]);
  const [mode, setMode] = useState<"login" | "register" | "recover">("login");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [resetEmail, setResetEmail] = useState("");
  const [resetToken, setResetToken] = useState(initialResetToken);
  const [newPassword, setNewPassword] = useState("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewToken, setPreviewToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (isLoading) {
    return <div className="empty-state">Sto controllando la sessione...</div>;
  }

  if (token) {
    return <Navigate to="/" replace />;
  }

  async function handleAuthSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setMessage(null);
    setIsSubmitting(true);

    try {
      if (mode === "login") {
        await login(email, password);
      } else {
        await register(email, password, displayName);
      }
      navigate("/", { replace: true });
    } catch (submissionError) {
      setError(getErrorMessage(submissionError, "Operazione non riuscita."));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleForgotPassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setMessage(null);
    setPreviewUrl(null);
    setPreviewToken(null);
    setIsSubmitting(true);

    try {
      const result = await apiClient.forgotPassword(resetEmail);
      setMessage(result.message);
      if (showDevResetPreview) {
        setPreviewUrl(result.previewUrl ?? null);
        setPreviewToken(result.previewToken ?? null);
      }
      if (showDevResetPreview && result.previewToken) {
        setResetToken(result.previewToken);
      }
    } catch (submissionError) {
      setError(getErrorMessage(submissionError, "Operazione non riuscita."));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleResetPassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setMessage(null);
    setIsSubmitting(true);

    try {
      const result = await apiClient.resetPassword(resetToken, newPassword);
      setMessage(result.message);
      setMode("login");
      setPassword("");
      setNewPassword("");
    } catch (submissionError) {
      setError(getErrorMessage(submissionError, "Non sono riuscito a cambiare la password."));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="auth-layout">
      <section className="auth-panel">
        <p className="eyebrow">Accesso</p>
        <h1>Entra nel portale</h1>
        <p className="muted">
          Da qui puoi accedere, creare un account o recuperare la password. Tutto quello che conta resta salvato nel
          sistema, mentre nel browser vedi solo le pagine del portale.
        </p>

        <div className="toggle-group">
          <button
            className={mode === "login" ? "active" : ""}
            onClick={() => setMode("login")}
            type="button"
          >
            Accedi
          </button>
          <button
            className={mode === "register" ? "active" : ""}
            onClick={() => setMode("register")}
            type="button"
          >
            Crea account
          </button>
          <button
            className={mode === "recover" ? "active" : ""}
            onClick={() => setMode("recover")}
            type="button"
          >
            Password dimenticata
          </button>
        </div>

        {mode === "recover" ? (
          <form className="auth-form" onSubmit={handleForgotPassword}>
            <label>
              Email
              <input
                autoComplete="email"
                type="email"
                value={resetEmail}
                onChange={(event) => setResetEmail(event.target.value)}
                required
              />
            </label>

            <button disabled={isSubmitting} type="submit">
              {isSubmitting ? "Invio..." : "Invia istruzioni"}
            </button>
          </form>
        ) : (
          <form className="auth-form" onSubmit={handleAuthSubmit}>
            {mode === "register" ? (
              <label>
                Nome
                <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} required />
              </label>
            ) : null}

            <label>
              Email
              <input
                autoComplete="email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </label>

            <label>
              Password
              <input
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                minLength={8}
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </label>

            <button disabled={isSubmitting} type="submit">
              {isSubmitting ? "Attendi..." : mode === "login" ? "Entra" : "Crea account"}
            </button>
          </form>
        )}

        <form className="auth-form reset-form" onSubmit={handleResetPassword}>
          <h3>Imposta una nuova password</h3>
          <label>
            Codice di reset
            <input value={resetToken} onChange={(event) => setResetToken(event.target.value)} required />
          </label>
          <label>
            Nuova password
            <input
              minLength={8}
              type="password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              required
            />
          </label>
          <button disabled={isSubmitting} type="submit">
            {isSubmitting ? "Aggiorno..." : "Salva nuova password"}
          </button>
        </form>

        {message ? <p className="success-banner">{message}</p> : null}
        {error ? <p className="error-banner">{error}</p> : null}

        {showDevResetPreview && (previewToken || previewUrl) ? (
          <div className="preview-box">
            <strong>Anteprima locale</strong>
            {previewToken ? <code>{previewToken}</code> : null}
            {previewUrl ? (
              <a href={previewUrl} rel="noreferrer" target="_blank">
                Apri la pagina di reset
              </a>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}
