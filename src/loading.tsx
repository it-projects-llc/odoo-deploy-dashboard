import { useEffect } from "react";
import { ChevronDown, GitBranch, Search } from "lucide-react";

// Show the dashboard layout while authenticating/reloading; persist no provider data.
export function DashboardLoading({
  error,
  retry,
}: {
  error?: string;
  retry?: () => void;
}) {
  const params = new URLSearchParams(location.search);
  const page = params.get("view") ?? "branches";
  const tab = params.get("tab") ?? "history";
  useEffect(() => {
    try {
      document.documentElement.dataset.theme = JSON.parse(
        localStorage.getItem("odoo-dashboard:v1:theme") ?? '"light"',
      );
    } catch {
      /* Preferences are optional. */
    }
  }, []);
  return (
    <div className="dashboard-loading" aria-busy="true" aria-label="Dashboard">
      <header className="topbar">
        <a className="brand" href="?view=branches">
          <span>odoo</span>
          <span className="brand-dot">.</span>
          <span className="brand-tail">deploy</span>
        </a>
        <nav aria-label="Main navigation">
          {[
            ["branches", "Branches"],
            ["builds", "Builds"],
            ["status", "Status"],
          ].map(([id, name]) => (
            <button key={id} className={id === page ? "active" : ""} disabled>
              {name}
            </button>
          ))}
        </nav>
        <div className="top-right">
          <span className="skeleton skeleton-project" aria-hidden="true" />
        </div>
      </header>
      {error && (
        <div className="alert" role="alert">
          {error}
          <button onClick={retry}>Retry</button>
        </div>
      )}
      {page === "branches" ? (
        <div className="workspace">
          <aside className="sidebar">
            <div className="branch-search">
              <Search size={14} />
              <input
                aria-label="Filter branches"
                placeholder="Filter branches…"
                disabled
              />
            </div>
            <div className="branch-groups">
              {["Production", "Staging", "Development"].map((stage) => (
                <section className="branch-group" key={stage}>
                  <button className="group-label" disabled>
                    <ChevronDown size={12} />
                    <span>{stage}</span>
                  </button>
                  <div className="loading-branch">
                    <GitBranch size={13} />
                    <span className="skeleton" aria-hidden="true" />
                  </div>
                </section>
              ))}
            </div>
          </aside>
          <main className="branch-main">
            <div className="branch-heading">
              <span className="skeleton skeleton-heading" aria-hidden="true" />
            </div>
            <div className="tabs" role="tablist" aria-label="Branch sections">
              {["history", "shell", "monitor", "logs", "settings"].map(
                (name) => (
                  <button
                    key={name}
                    role="tab"
                    aria-selected={name === tab}
                    className={name === tab ? "selected" : ""}
                    disabled
                  >
                    {name.toUpperCase()}
                  </button>
                ),
              )}
            </div>
            <div className="loading-content" aria-hidden="true">
              <div className="skeleton skeleton-panel" />
              {[0, 1, 2].map((n) => (
                <div className="skeleton skeleton-row" key={n} />
              ))}
            </div>
          </main>
        </div>
      ) : (
        <main className="loading-content" aria-hidden="true">
          <div className="skeleton skeleton-panel" />
          {[0, 1, 2].map((n) => (
            <div className="skeleton skeleton-row" key={n} />
          ))}
        </main>
      )}
    </div>
  );
}
