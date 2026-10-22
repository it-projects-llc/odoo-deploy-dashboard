import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { LoaderCircle, LockKeyhole } from "lucide-react";

// Every protected read reports expiry to the gate, which unmounts cached views and Shell.
export async function apiFetch(input: RequestInfo | URL, init?: RequestInit) {
  const response = await fetch(input, init);
  if (response.status === 401)
    window.dispatchEvent(new Event("dashboard-session-expired"));
  return response;
}
type LoginState = {
  authenticated: boolean;
  user?: string;
  mode: "komodo" | "proxy" | "test";
};
export function LoginGate({
  children,
  pending,
}: {
  pending: ReactNode;
  children: (user: string | undefined, logout: () => void) => ReactNode;
}) {
  const [session, setSession] = useState<LoginState>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [totp, setTotp] = useState(false);
  async function check() {
    setBusy(true);
    try {
      const response = await fetch("/api/auth/session");
      const body = await response.json();
      if (!response.ok)
        throw new Error(body.error || "Unable to check your session.");
      setSession(body);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to connect.");
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void check();
    const expired = () => {
      setSession((previous) => ({
        authenticated: false,
        mode: previous?.mode ?? "komodo",
      }));
      setTotp(false);
      setCode("");
      setPassword("");
      setError("Your session ended. Sign in again.");
    };
    window.addEventListener("dashboard-session-expired", expired);
    return () =>
      window.removeEventListener("dashboard-session-expired", expired);
  }, []);
  async function login(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const body = totp ? { code } : { username, password };
    setPassword("");
    setCode("");
    try {
      const response = await fetch(
        totp ? "/api/auth/totp" : "/api/auth/login",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Unable to sign in.");
      if (result.challenge === "totp") setTotp(true);
      else {
        setTotp(false);
        setSession({ authenticated: true, user: result.user, mode: "komodo" });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to sign in.");
    } finally {
      setBusy(false);
    }
  }
  async function logout() {
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (!response.ok) throw new Error("Unable to sign out. Try again.");
      setSession((previous) => ({
        authenticated: false,
        mode: previous?.mode ?? "komodo",
      }));
      setError("");
      setUsername("");
      setTotp(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to sign out.");
    }
  }
  if (session?.authenticated)
    return (
      <>
        {error && (
          <div className="alert" role="alert">
            {error}
          </div>
        )}
        {children(
          session.mode === "komodo" ? session.user : undefined,
          () => void logout(),
        )}
      </>
    );
  if (!session && !error) return <>{pending}</>;
  return (
    <main className="login-page">
      <div className="login-card">
        <a className="brand login-brand" href="/">
          <span>odoo</span>
          <span className="brand-dot">.</span>
          <span className="brand-tail">deploy</span>
        </a>
        <div className="login-icon">
          <LockKeyhole size={22} strokeWidth={1.5} />
        </div>
        {totp && <h1>Verify your login</h1>}
        <p>
          {totp
            ? "Enter the code from your authenticator app."
            : "Sign in with your Komodo account."}
        </p>
        {error && (
          <div className="login-error" role="alert">
            {error}
          </div>
        )}
        {!session ? (
          <button
            className="login-submit"
            onClick={() => void check()}
            disabled={busy}
          >
            {busy ? (
              <>
                <LoaderCircle className="spin" size={16} /> Connecting…
              </>
            ) : (
              "Try again"
            )}
          </button>
        ) : session.mode === "proxy" ? (
          <p>Access this dashboard through your configured identity proxy.</p>
        ) : (
          <form onSubmit={login}>
            {totp ? (
              <label htmlFor="login-code">
                Authentication code
                <input
                  id="login-code"
                  name="code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  autoFocus
                  required
                />
              </label>
            ) : (
              <>
                <label htmlFor="login-username">
                  Username
                  <input
                    id="login-username"
                    name="username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    autoComplete="username"
                    maxLength={200}
                    autoFocus
                    required
                  />
                </label>
                <label htmlFor="login-password">
                  Password
                  <input
                    id="login-password"
                    name="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                    maxLength={1024}
                    required
                  />
                </label>
              </>
            )}
            <button className="login-submit" type="submit" disabled={busy}>
              {busy && <LoaderCircle className="spin" size={16} />}
              {busy ? "Signing in…" : totp ? "Verify and sign in" : "Sign in"}
            </button>
            {totp && (
              <button
                className="login-back"
                type="button"
                onClick={() => {
                  setTotp(false);
                  setCode("");
                  setError("");
                }}
              >
                Back to sign in
              </button>
            )}
          </form>
        )}
      </div>
    </main>
  );
}
