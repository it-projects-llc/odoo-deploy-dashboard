import { DashboardLoading } from "./loading";
import { LoginGate, apiFetch } from "./login";
import React, { lazy, Suspense, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  Box,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  Code2,
  Copy,
  ExternalLink,
  Filter,
  GitBranch,
  GitCommitHorizontal,
  Layers3,
  LoaderCircle,
  Moon,
  Pause,
  Play,
  RefreshCw,
  Search,
  Settings2,
  Sun,
  TerminalSquare,
  TriangleAlert,
  X,
  XCircle,
} from "lucide-react";
import type {
  Environment,
  Project,
  Snapshot,
  Result,
  Commit,
  Attempt,
  Logs,
  ClientSocketStatus,
} from "./types.ts";
const Shell = lazy(() =>
  import("./shell.tsx").then((m) => ({ default: m.Shell })),
);

import "./style.css";
const labels: Record<Result, string> = {
  passed: "Success",
  warning: "Warning",
  failed: "Failed",
  running: "Running",
  pending: "Pending",
  cancelled: "Cancelled",
  skipped: "Skipped",
  unknown: "Unknown",
};
function ago(date: string) {
  const mins = Math.max(
    0,
    Math.floor((Date.now() - new Date(date).getTime()) / 60000),
  );
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)} hours ago`;
  return `${Math.floor(mins / 1440)} days ago`;
}
function day(date: string) {
  return new Date(date).toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}
function duration(a: Attempt) {
  if (!a.end) return a.state === "running" ? "In progress" : "—";
  const sec = Math.max(
    0,
    Math.round((+new Date(a.end) - +new Date(a.date)) / 1000),
  );
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}
function readPref<T>(key: string, fallback: T): T {
  try {
    return (
      JSON.parse(localStorage.getItem(`odoo-dashboard:v1:${key}`) ?? "null") ??
      fallback
    );
  } catch {
    return fallback;
  }
}
function savePref(key: string, value: unknown) {
  try {
    localStorage.setItem(`odoo-dashboard:v1:${key}`, JSON.stringify(value));
  } catch {
    /* Browsers may disable local storage. */
  }
}
function Badge({ state, small = false }: { state: Result; small?: boolean }) {
  const Icon =
    state === "passed"
      ? Check
      : state === "warning"
        ? TriangleAlert
        : state === "failed"
          ? XCircle
          : ["running", "pending"].includes(state)
            ? LoaderCircle
            : CircleHelp;
  return (
    <span className={`badge ${state} ${small ? "small" : ""}`}>
      <Icon size={small ? 11 : 13} />
      {labels[state]}
    </span>
  );
}
function Dot({ state }: { state: string }) {
  return <span className={`dot ${state}`} />;
}
function Link({
  href,
  children,
  className = "",
}: {
  href?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return href ? (
    <a className={className} href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ) : null;
}
function Empty({
  title,
  children,
}: {
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <Box size={30} strokeWidth={1.2} />
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
function App({ user, onLogout }: { user?: string; onLogout: () => void }) {
  const [snapshot, setSnapshot] = useState<Snapshot>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [socketStatus, setSocketStatus] = useState<ClientSocketStatus>("Idle");
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  const params = new URLSearchParams(location.search);
  const [page, setPage] = useState(params.get("view") ?? "branches");
  const [projectId, setProjectId] = useState(
    params.get("project") ?? readPref("project", ""),
  );
  const [envId, setEnvId] = useState(
    params.get("branch") ?? readPref("branch", "prod"),
  );
  const [tab, setTab] = useState(params.get("tab") ?? "history");
  const [filter, setFilter] = useState(""),
    [resultFilter, setResultFilter] = useState("all");
  const [theme, setTheme] = useState(readPref("theme", "light"));
  const [collapsed, setCollapsed] = useState<string[]>(
    readPref("collapsed", []),
  );
  const [detail, setDetail] = useState<{
    commit?: Commit;
    attempt?: Attempt;
    environment: Environment;
  }>();
  const [help, setHelp] = useState(false);
  useEffect(() => {
    if (!detail && !help) return;
    const previous = document.activeElement as HTMLElement | null;
    const listener = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setDetail(undefined);
        setHelp(false);
      }
      if (e.key === "Tab") {
        const dialog = document.querySelector("[role=dialog]");
        const focusable = Array.from(
          dialog?.querySelectorAll<HTMLElement>(
            "button:not(:disabled), a[href], input, select",
          ) ?? [],
        );
        if (!focusable.length) return;
        const first = focusable[0],
          last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", listener);
    return () => {
      document.removeEventListener("keydown", listener);
      previous?.focus();
    };
  }, [!!detail, help]);
  const inFlight = useRef(false);
  const load = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const res = await apiFetch("/api/snapshot");
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      setSnapshot(body);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to connect");
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  };
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, snapshot?.pollMs ?? 15000);
    return () => clearInterval(timer);
  }, [snapshot?.pollMs]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    savePref("theme", theme);
  }, [theme]);
  const project =
    snapshot?.projects.find((p) => p.id === projectId) ?? snapshot?.projects[0];
  const env =
    project?.environments.find((e) => e.id === envId) ??
    project?.environments[0];
  useEffect(() => {
    if (!snapshot) return;
    if (project) savePref("project", project.id);
    if (env) savePref("branch", env.id);
    const query = new URLSearchParams({
      view: page,
      ...(project ? { project: project.id } : {}),
      ...(env ? { branch: env.id } : {}),
      tab,
    });
    history.replaceState(null, "", `?${query}`);
  }, [page, project?.id, env?.id, tab]);
  const selectEnv = (e: Environment) => {
    setEnvId(e.id);
    setTab("history");
    setPage("branches");
  };
  const visible = (e: Environment) =>
    `${e.branch} ${e.name}`.toLowerCase().includes(filter.toLowerCase());
  const selectLogs = (environment: Environment, attempt?: Attempt) => {
    setEnvId(environment.id);
    setTab("logs");
    setPage("branches");
    setDetail(undefined);
    setLogTarget(attempt?.id ?? "runtime");
  };
  const [logTarget, setLogTarget] = useState("runtime");
  if (!snapshot)
    return <DashboardLoading error={error} retry={() => void load()} />;
  return (
    <>
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
          ].map(([id, label]) => (
            <button
              key={id}
              className={page === id ? "active" : ""}
              onClick={() => setPage(id)}
            >
              {label}
            </button>
          ))}
          <button onClick={() => setHelp(true)}>
            Guide <ExternalLink size={11} />
          </button>
        </nav>
        <div className="top-right">
          {user && (
            <button
              className="session-user"
              onClick={onLogout}
              title={`Signed in as ${user}`}
            >
              {user} · Sign out
            </button>
          )}
          <label className="project-select">
            <Layers3 size={14} />
            <select
              aria-label="Project"
              value={project?.id ?? ""}
              onChange={(e) => {
                setProjectId(e.target.value);
                setEnvId("");
              }}
            >
              {snapshot.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.repository ? ` · ${p.repository}` : ""}
                </option>
              ))}
            </select>
            <ChevronDown size={12} />
          </label>
          <button
            className="icon-button"
            aria-label="Toggle theme"
            onClick={() => setTheme(theme === "light" ? "dark" : "light")}
          >
            {theme === "light" ? <Moon size={15} /> : <Sun size={15} />}
          </button>
        </div>
      </header>
      {(error || snapshot.stale) && (
        <div className="alert" role="status">
          <TriangleAlert size={15} />
          {error ||
            snapshot.issues?.join(" ") ||
            "Some provider data is unavailable. Available sections remain visible."}
          {error && " Showing the last successful snapshot."}
          <button onClick={load}>Retry</button>
        </div>
      )}
      {!snapshot.projects.length && (
        <Empty
          title={
            snapshot.stale
              ? "Deployment data unavailable"
              : "No deployments available"
          }
        >
          {snapshot.stale
            ? "Some provider checks failed. Review the message above and retry when the provider or configuration has been corrected."
            : "No readable stacks were found. Check your Komodo account's stack permissions."}
        </Empty>
      )}
      {page === "branches" && project && env ? (
        <div className="workspace">
          <aside className="sidebar">
            <div className="branch-search">
              <Search size={14} />
              <input
                aria-label="Filter branches"
                placeholder="Filter branches…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>
            <div className="branch-groups">
              {(["Production", "Staging", "Development"] as const).map(
                (stage) => (
                  <section className="branch-group" key={stage}>
                    <button
                      className="group-label"
                      onClick={() => {
                        const next = collapsed.includes(stage)
                          ? collapsed.filter((x) => x !== stage)
                          : [...collapsed, stage];
                        setCollapsed(next);
                        savePref("collapsed", next);
                      }}
                    >
                      {collapsed.includes(stage) ? (
                        <ChevronRight size={12} />
                      ) : (
                        <ChevronDown size={12} />
                      )}
                      <span>{stage}</span>
                      <span className="group-count">
                        {
                          project.environments.filter((e) => e.stage === stage)
                            .length
                        }
                      </span>
                    </button>
                    {!collapsed.includes(stage) &&
                      project.environments
                        .filter((e) => e.stage === stage && visible(e))
                        .map((e) => (
                          <button
                            className={`branch-row ${env.id === e.id ? "selected" : ""}`}
                            key={e.id}
                            onClick={() => selectEnv(e)}
                          >
                            <GitBranch size={13} />
                            <span title={e.branch}>{e.branch}</span>
                            <small>{e.version}</small>
                            <Dot state={e.commits[0]?.result ?? "unknown"} />
                          </button>
                        ))}
                  </section>
                ),
              )}
            </div>
          </aside>
          <main className="branch-main">
            <div className="branch-heading">
              <div className="branch-title">
                <span className={`stage-tag ${env.stage.toLowerCase()}`}>
                  {env.stage === "Unknown" ? "Unclassified" : env.stage}
                </span>
                <h1>
                  <GitBranch size={20} />
                  {env.branch}
                </h1>
                <p>{env.stack ?? "CI only · no deployment configured"}</p>
              </div>
              <div className="heading-meta">
                <div className="runtime-pill">
                  <Dot state={env.health} />
                  {env.health === "healthy"
                    ? "Running"
                    : env.health === "not deployed"
                      ? "No instance"
                      : env.health}
                </div>
                <Link href={env.url} className="open-button">
                  Open Odoo <ExternalLink size={13} />
                </Link>
              </div>
            </div>
            <div className="tabs" role="tablist" aria-label="Branch sections">
              {[
                ["history", "History", GitCommitHorizontal],
                ["shell", "Shell", TerminalSquare],
                ["monitor", "Monitor", Activity],
                ["logs", "Logs", Code2],
                ["settings", "Settings", Settings2],
              ].map(([id, label, Icon]) => {
                const I = Icon as typeof Activity;
                return (
                  <button
                    key={String(id)}
                    role="tab"
                    aria-selected={tab === id}
                    className={tab === id ? "selected" : ""}
                    onClick={() => setTab(String(id))}
                  >
                    <I size={14} />
                    {String(label)}
                    {id === "shell" && !env.terminal && (
                      <span className="tab-marker" />
                    )}
                  </button>
                );
              })}
              <Link href={project.repoUrl} className="repo-link">
                Forgejo <ExternalLink size={12} />
              </Link>
            </div>
            {project.notice && (
              <div className="provider-note">
                <CircleHelp size={14} />
                {project.notice}
              </div>
            )}
            {env.issues.length > 0 && (
              <div className="provider-note">
                <TriangleAlert size={14} />
                {[...new Set(env.issues)].join(" ")}
              </div>
            )}
            {tab === "history" && (
              <HistoryView
                key={`${project.id}:${env.id}`}
                project={project}
                env={env}
                onDetail={(commit) => setDetail({ commit, environment: env })}
              />
            )}
            {tab === "logs" && (
              <LogViewer
                key={`${project.id}:${env.id}`}
                project={project}
                env={env}
                initialSource={logTarget}
              />
            )}
            {tab === "shell" && (
              <Suspense fallback={<Empty title="Loading terminal…" />}>
                <Shell
                  key={`${project.id}:${env.id}`}
                  project={project}
                  env={env}
                  onSocketStatus={setSocketStatus}
                />
              </Suspense>
            )}
            {tab === "monitor" && <Monitor env={env} />}
            {tab === "settings" && (
              <Settings
                env={env}
                project={project}
                theme={theme}
                setTheme={setTheme}
              />
            )}
          </main>
        </div>
      ) : null}
      {page === "builds" && project && (
        <main className="builds-page">
          <div className="page-heading">
            <div>
              <span className="eyebrow">PROJECT OVERVIEW</span>
              <h1>Builds & deployments</h1>
              <p>Source checks and deployment attempts, side by side.</p>
            </div>
            <button onClick={load}>
              <RefreshCw className={busy ? "spin" : ""} size={14} /> Refresh
            </button>
          </div>
          <div className="board-tools">
            <label>
              <Search size={15} />
              <input
                placeholder="Filter branches…"
                aria-label="Filter build branches"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </label>
            <label className="result-filter">
              <Filter size={13} />
              <select
                aria-label="Filter results"
                value={resultFilter}
                onChange={(e) => setResultFilter(e.target.value)}
              >
                <option value="all">All results</option>
                {Object.entries(labels).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <span>
              Latest on the left <ArrowLeft size={12} />
            </span>
          </div>
          {(["Production", "Staging", "Development"] as const).map((stage) => (
            <section className="board-stage" key={stage}>
              <div className="board-stage-label">
                <span>{stage}</span>
                <small>
                  {project.environments.filter((e) => e.stage === stage).length}{" "}
                  branches
                </small>
              </div>
              {project.environments
                .filter((e) => e.stage === stage && visible(e))
                .map((e) => (
                  <div className="board-row" key={e.id}>
                    <div className="board-identity">
                      <button onClick={() => selectEnv(e)}>
                        <Dot state={e.commits[0]?.result ?? "unknown"} />
                        <strong>{e.branch}</strong>
                      </button>
                      <small>{e.stack ?? "CI only"}</small>
                      <button
                        className="text-link"
                        onClick={() => selectEnv(e)}
                      >
                        View branch <ArrowRight size={12} />
                      </button>
                    </div>
                    <div className="build-cards">
                      {[
                        ...e.commits.map((c) => ({
                          date: c.date,
                          key: c.sha,
                          commit: c,
                          attempt: undefined as Attempt | undefined,
                        })),
                        ...e.attempts.map((a) => ({
                          date: a.date,
                          key: a.id,
                          commit: undefined as Commit | undefined,
                          attempt: a,
                        })),
                      ]
                        .sort((a, b) => +new Date(b.date) - +new Date(a.date))
                        .filter(
                          (r) =>
                            resultFilter === "all" ||
                            (r.commit?.result ?? r.attempt?.state) ===
                              resultFilter,
                        )
                        .map((record) =>
                          record.commit
                            ? (() => {
                                const c = record.commit;
                                return (
                                  <button
                                    className={`build-card ${c.result}`}
                                    key={record.key}
                                    onClick={() =>
                                      setDetail({ commit: c, environment: e })
                                    }
                                  >
                                    <strong className="card-subject">
                                      {c.message}
                                    </strong>
                                    <div className="card-person">
                                      <span className="avatar tiny-avatar">
                                        {c.author.charAt(0)}
                                      </span>
                                      {c.author}
                                    </div>
                                    <div className="card-age">
                                      <Clock3 size={12} />
                                      {ago(c.date)}
                                    </div>
                                    <div className="card-footer">
                                      <span className="version-badge">
                                        {e.version}
                                      </span>
                                      <Badge state={c.result} small />
                                      <code>{c.sha.slice(0, 8)}</code>
                                      <ChevronRight size={13} />
                                    </div>
                                  </button>
                                );
                              })()
                            : (() => {
                                const a = record.attempt!;
                                return (
                                  <button
                                    key={record.key}
                                    className={`build-card deployment-card ${a.state}`}
                                    onClick={() =>
                                      setDetail({
                                        attempt: a,
                                        environment: e,
                                      })
                                    }
                                  >
                                    <div className="card-type">
                                      <Box size={12} />
                                      DEPLOYMENT
                                    </div>
                                    <strong>{a.operation}</strong>
                                    <div className="card-person">{a.actor}</div>
                                    <div className="card-age">
                                      <Clock3 size={12} />
                                      {ago(a.date)} · {duration(a)}
                                    </div>
                                    <div className="card-footer">
                                      <Badge state={a.state} small />
                                      <code>
                                        {a.infraSha?.slice(0, 8) ??
                                          "Unverified SHA"}
                                      </code>
                                    </div>
                                  </button>
                                );
                              })(),
                        )}
                      {!e.commits.length && !e.attempts.length && (
                        <span className="board-empty">
                          No records available from providers.
                        </span>
                      )}
                    </div>
                  </div>
                ))}
            </section>
          ))}
        </main>
      )}
      {page === "status" && (
        <Status
          snapshot={snapshot}
          refreshError={error}
          onSelect={(environment) => {
            const owner = snapshot.projects.find((p) =>
              p.environments.some((e) => e.id === environment.id),
            );
            if (owner) setProjectId(owner.id);
            selectEnv(environment);
          }}
        />
      )}
      <footer className="statusbar">
        <div
          className="component-health"
          aria-label="Component health"
          role="status"
        >
          {["Forgejo", "Komodo"].map((name) => {
            const provider = snapshot.providers.find((p) => p.name === name);
            const status = !online
              ? "Offline"
              : error
                ? "Unknown"
                : provider?.state === "connected"
                  ? "Healthy"
                  : provider?.state === "unavailable"
                    ? "Degraded"
                    : "Not checked";
            return (
              <span
                className="component-status"
                key={name}
                title={
                  !online
                    ? "Client is offline; integration status cannot be refreshed."
                    : error
                      ? "Dashboard refresh failed; last integration status is no longer current."
                      : provider?.state === "test" || !provider
                        ? "No live integration check has been performed."
                        : `${name}: ${status}. Checked ${new Date(provider.checkedAt).toLocaleString()}.`
                }
              >
                <Dot
                  state={
                    status === "Healthy"
                      ? "healthy"
                      : status === "Degraded"
                        ? "warning"
                        : "unknown"
                  }
                />
                {name}: {status}
              </span>
            );
          })}
          <span
            className="component-status"
            title="Client-to-dashboard terminal WebSocket. Idle until a terminal connection is opened."
          >
            <Dot
              state={
                !online || socketStatus === "Error"
                  ? "failed"
                  : socketStatus === "Connected"
                    ? "healthy"
                    : socketStatus === "Connecting"
                      ? "pending"
                      : "unknown"
              }
            />
            Client WebSocket:{" "}
            {!online
              ? "Offline"
              : socketStatus === "Connected"
                ? "Healthy"
                : socketStatus}
          </span>
        </div>
        <span>
          <Clock3 size={11} /> Updated{" "}
          {new Date(snapshot.fetchedAt).toLocaleTimeString()}
          <button aria-label="Refresh dashboard" onClick={load}>
            <RefreshCw size={12} className={busy ? "spin" : ""} />
          </button>
        </span>
      </footer>
      {detail && (
        <div className="modal-backdrop" onClick={() => setDetail(undefined)}>
          <section
            className="detail-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Build details"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <div>
                <span className="eyebrow">
                  {detail.attempt ? "DEPLOYMENT ATTEMPT" : "SOURCE COMMIT"}
                </span>
                <h2>
                  {detail.commit?.message ??
                    `Komodo deployment · ${detail.environment.name}`}
                </h2>
              </div>
              <button
                aria-label="Close build details"
                onClick={() => setDetail(undefined)}
                autoFocus
              >
                <X size={20} />
              </button>
            </div>
            <div className="modal-content">
              <div className="detail-summary">
                <Badge state={detail.commit?.result ?? detail.attempt!.state} />
                <span>
                  <GitBranch size={13} />
                  {detail.environment.branch}
                </span>
                <span>
                  <Clock3 size={13} />
                  {ago(detail.commit?.date ?? detail.attempt!.date)}
                </span>
              </div>
              <dl className="detail-fields">
                <dt>
                  {detail.attempt ? "Infrastructure SHA" : "Application SHA"}
                </dt>
                <dd>
                  <code>
                    {detail.commit?.sha ??
                      detail.attempt?.infraSha ??
                      "Not reported by provider"}
                  </code>
                </dd>
                <dt>{detail.attempt ? "Operator" : "Author"}</dt>
                <dd>{detail.commit?.author ?? detail.attempt?.actor}</dd>
                <dt>Stack</dt>
                <dd>
                  {detail.environment.stack ?? "No deployment configured"}
                </dd>
              </dl>
              {detail.commit && (
                <>
                  <h3>
                    Commit checks{" "}
                    <span className="muted">{detail.commit.checks.length}</span>
                  </h3>
                  <div className="check-list">
                    {detail.commit.checks.map((c) => (
                      <div key={c.name}>
                        <Badge state={c.state} />
                        <span>
                          <strong>{c.name}</strong>
                          <small>{c.description}</small>
                        </span>
                        <Link href={c.url}>
                          <ExternalLink size={14} />
                        </Link>
                      </div>
                    ))}
                  </div>
                  {!detail.commit.checks.length && (
                    <p className="muted">No commit statuses reported.</p>
                  )}
                </>
              )}
              <p className="inline-note">
                <CircleHelp size={15} />A passing source check does not mean
                this commit is deployed. Deployment records are tracked
                separately.
              </p>
            </div>
            <div className="modal-footer">
              <Link
                href={detail.commit?.url ?? detail.attempt?.url}
                className="button"
              >
                View in {detail.attempt ? "Komodo" : "Forgejo"}{" "}
                <ExternalLink size={13} />
              </Link>
              {detail.attempt && (
                <button
                  className="primary"
                  onClick={() => selectLogs(detail.environment, detail.attempt)}
                >
                  View deployment logs <Code2 size={14} />
                </button>
              )}
              <button onClick={() => setDetail(undefined)}>Close</button>
            </div>
          </section>
        </div>
      )}
      {help && (
        <div className="modal-backdrop" onClick={() => setHelp(false)}>
          <section
            className="detail-modal guide-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Dashboard guide"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h2>Your deployment workspace</h2>
              <button
                onClick={() => setHelp(false)}
                aria-label="Close guide"
                autoFocus
              >
                <X size={19} />
              </button>
            </div>
            <div className="modal-content">
              <p>
                Follow application commits in Forgejo, inspect deployment
                attempts in Komodo, and read current service logs from one
                workspace.
              </p>
              <h3>Connect your providers</h3>
              <p>
                Copy <code>.env.example</code> to <code>.env</code>, configure
                the Forgejo read token, Komodo URL and session secret, then set{" "}
                <code>work_env=prod</code>. Sign in with your Komodo username
                and password.
              </p>
              <h3>No dashboard database</h3>
              <p>
                Server configuration lives in environment variables. Display
                preferences live in this browser. History and logs come from
                Forgejo and Komodo; server caches are temporary.
              </p>
              <h3>Optional interactive Shell</h3>
              <p>
                Shell uses Komodo's terminal service with your account
                permissions and an enabled target policy. It can change the
                target environment. No SSH connection is managed by this
                dashboard.
              </p>
              <p className="muted">
                See README.md for configuration, container deployment, and
                compatibility details.
              </p>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
function HistoryView({
  project,
  env,
  onDetail,
}: {
  project: Project;
  env: Environment;
  onDetail: (c: Commit) => void;
}) {
  const [older, setOlder] = useState<Commit[]>([]),
    [next, setNext] = useState(env.nextCommitPage),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    setOlder([]);
    setNext(env.nextCommitPage);
    setError("");
  }, [project.id, env.id]);
  const hasApplicationRepository =
    project.sourceKind !== "infrastructure" && project.sourceKind !== "none";
  const commits = hasApplicationRepository
    ? [...env.commits, ...older].sort(
        (a, b) => +new Date(b.date) - +new Date(a.date),
      )
    : [];
  return (
    <div className="history-content">
      <div className="environment-strip">
        <div>
          <span className="eyebrow">CURRENT INSTANCE</span>
          <strong>
            <Dot state={env.health} />
            {env.health === "healthy" ? "Odoo is running" : env.health}
          </strong>
        </div>
        <div>
          <span className="eyebrow">DEPLOYED INFRASTRUCTURE</span>
          <code>{env.deployedInfraSha?.slice(0, 12) ?? "Not reported"}</code>
        </div>
        <div>
          <span className="eyebrow">LATEST DEPLOYMENT</span>
          {env.attempts[0] ? (
            <Badge state={env.attempts[0].state} />
          ) : (
            <span className="muted">No attempts</span>
          )}
        </div>
        <Link href={env.url} className="button">
          Open <ExternalLink size={12} />
        </Link>
      </div>
      <div className="history-heading">
        <div>
          <h2>Branch history</h2>
          <p>Commits from the application repository</p>
        </div>
      </div>
      {!commits.length ? (
        <Empty title="No application commits available">
          {hasApplicationRepository
            ? "The branch may be empty or unavailable. Check repository permissions."
            : "Configure the application repository to view module-code commits."}
        </Empty>
      ) : (
        <div className="timeline">
          {commits.map((commit, i) => (
            <React.Fragment key={commit.sha}>
              {(i === 0 || day(commits[i - 1].date) !== day(commit.date)) && (
                <div className="timeline-date">{day(commit.date)}</div>
              )}
              <article className="timeline-event">
                <span className="timeline-node">
                  <GitCommitHorizontal size={15} />
                </span>
                <div className="event-body">
                  <div className="event-person">
                    <span className="avatar">{commit.author.charAt(0)}</span>
                    <strong>{commit.author}</strong>
                    <span>· {ago(commit.date)}</span>
                  </div>
                  <button
                    className="commit-strip"
                    onClick={() => onDetail(commit)}
                  >
                    <GitCommitHorizontal size={12} />
                    <span>{commit.message}</span>
                    <code>{commit.sha.slice(0, 8)}</code>
                  </button>
                </div>
                <div className="event-result">
                  <small>Checks</small>
                  <Badge state={commit.result} />
                  <button onClick={() => onDetail(commit)}>
                    Details <ChevronRight size={12} />
                  </button>
                </div>
              </article>
            </React.Fragment>
          ))}
        </div>
      )}
      {hasApplicationRepository && next && (
        <button
          className="load-more"
          disabled={loading}
          onClick={async () => {
            setLoading(true);
            try {
              const r = await apiFetch(
                `/api/commits?${new URLSearchParams({ project: project.id, environment: env.id, page: String(next) })}`,
              );
              const d = await r.json();
              if (!r.ok) throw new Error(d.error);
              setOlder((prev) => [
                ...prev,
                ...d.commits.filter(
                  (c: Commit) =>
                    !env.commits.some((x) => x.sha === c.sha) &&
                    !prev.some((x) => x.sha === c.sha),
                ),
              ]);
              setNext(d.nextPage);
            } catch {
              setError("Older commits could not be loaded.");
            } finally {
              setLoading(false);
            }
          }}
        >
          {loading ? (
            <LoaderCircle className="spin" size={13} />
          ) : (
            <ChevronDown size={13} />
          )}
          Load older commits
        </button>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
function LogViewer({
  project,
  env,
  initialSource,
}: {
  project: Project;
  env: Environment;
  initialSource: string;
}) {
  const [source, setSource] = useState(
      initialSource === "runtime" ? "runtime" : "deploy",
    ),
    [attempt, setAttempt] = useState(
      initialSource === "runtime" ? (env.attempts[0]?.id ?? "") : initialSource,
    ),
    [run, setRun] = useState(String(env.runs[0]?.id ?? "")),
    [service, setService] = useState(
      env.terminalService || env.services[0]?.name || "odoo",
    ),
    [logs, setLogs] = useState<Logs>(),
    [error, setError] = useState(""),
    [paused, setPaused] = useState(false),
    [search, setSearch] = useState(""),
    [follow, setFollow] = useState(true),
    [stage, setStage] = useState("all"),
    [busy, setBusy] = useState(false),
    [copyNote, setCopyNote] = useState("");
  const consoleRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setLogs(undefined);
    setAttempt(
      initialSource === "runtime" ? (env.attempts[0]?.id ?? "") : initialSource,
    );
    setSource(initialSource === "runtime" ? "runtime" : "deploy");
    setRun(String(env.runs[0]?.id ?? ""));
    setService(env.terminalService || env.services[0]?.name || "odoo");
    setSearch("");
    setStage("all");
  }, [project.id, env.id, initialSource]);
  useEffect(() => {
    let disposed = false,
      inFlight = false;
    const controller = new AbortController();
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      setBusy(true);
      try {
        const q = new URLSearchParams({
          project: project.id,
          environment: env.id,
          source,
          service,
          ...(source === "deploy"
            ? { id: attempt }
            : source === "ci"
              ? { id: run }
              : {}),
        });
        const r = await apiFetch(`/api/logs?${q}`, {
          signal: controller.signal,
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error);
        if (!disposed) {
          setLogs(data);
          setError("");
        }
      } catch (e) {
        if (!disposed)
          setError(e instanceof Error ? e.message : "Logs unavailable");
      } finally {
        inFlight = false;
        if (!disposed) setBusy(false);
      }
    };
    if (!paused) void load();
    const timer = setInterval(() => {
      if (!paused && !document.hidden) void load();
    }, 5000);
    return () => {
      disposed = true;
      controller.abort();
      clearInterval(timer);
    };
  }, [project.id, env.id, source, service, attempt, run, paused]);
  useEffect(() => {
    setLogs(undefined);
    setError("");
    setStage("all");
  }, [source, service, attempt, run]);
  const lines = (logs?.entries ?? [])
    .filter((e) => stage === "all" || e.stage === stage)
    .flatMap((e) =>
      e.text.split("\n").map((text) => ({ text, stage: e.stage })),
    )
    .filter((l) => l.text.toLowerCase().includes(search.toLowerCase()))
    .slice(-5000);
  useEffect(() => {
    if (follow && consoleRef.current)
      consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
  }, [logs, follow]);
  const text = lines.map((l) => `[${l.stage}] ${l.text}`).join("\n");
  return (
    <section className="logs-view">
      <div className="log-toolbar">
        <label>
          Available logs
          <select
            aria-label="Log source"
            value={source}
            onChange={(e) => {
              setSource(e.target.value);
              setStage("all");
            }}
          >
            <option value="runtime">Current service output</option>
            <option value="deploy">Deployment output</option>
            <option value="ci">Forgejo CI jobs</option>
          </select>
        </label>
        {source === "runtime" ? (
          <select
            aria-label="Service"
            value={service}
            onChange={(e) => setService(e.target.value)}
          >
            {env.services.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name}
              </option>
            ))}
            {!env.services.length && <option value="odoo">odoo</option>}
          </select>
        ) : source === "deploy" ? (
          <select
            aria-label="Deployment attempt"
            value={attempt}
            onChange={(e) => setAttempt(e.target.value)}
          >
            {env.attempts.map((a) => (
              <option value={a.id} key={a.id}>
                {ago(a.date)} · {labels[a.state]} · {a.id.slice(0, 8)}
              </option>
            ))}
          </select>
        ) : (
          <select
            aria-label="Workflow run"
            value={run}
            onChange={(e) => setRun(e.target.value)}
          >
            {env.runs.map((r) => (
              <option value={r.id} key={r.id}>
                #{r.id} · {r.name}
              </option>
            ))}
          </select>
        )}
        <div className="log-toolbar-right">
          <label className="console-search">
            <Search size={14} />
            <input
              aria-label="Search log output"
              placeholder="Search output…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <button
            className={paused ? "paused" : ""}
            aria-label={paused ? "Resume logs" : "Pause logs"}
            title={paused ? "Resume fetching" : "Pause fetching"}
            onClick={() => setPaused(!paused)}
          >
            {paused ? <Play size={16} /> : <Pause size={16} />}
          </button>
        </div>
      </div>
      <div className="log-subtoolbar">
        <span>
          <Dot state={error ? "failed" : paused ? "unknown" : "healthy"} />
          {error
            ? "Output unavailable"
            : paused
              ? "Paused"
              : busy
                ? "Fetching…"
                : "Following provider output"}{" "}
          · {lines.length} lines
        </span>
        <select
          aria-label="Log stage"
          value={stage}
          onChange={(e) => setStage(e.target.value)}
        >
          <option value="all">All stages</option>
          {[...new Set(logs?.entries.map((e) => e.stage))].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <label>
          <input
            type="checkbox"
            checked={follow}
            onChange={(e) => setFollow(e.target.checked)}
          />
          Follow tail
        </label>
        <button
          aria-label="Copy visible logs"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text);
              setCopyNote("Copied");
            } catch {
              setCopyNote("Clipboard unavailable");
            }
          }}
        >
          <Copy size={12} />
          {copyNote || "Copy"}
        </button>
        <button
          onClick={() => {
            const u = URL.createObjectURL(
              new Blob([text], { type: "text/plain" }),
            );
            const a = document.createElement("a");
            a.href = u;
            a.download = `${env.id}-${source}.log`;
            a.click();
            URL.revokeObjectURL(u);
          }}
        >
          <ArrowDownToLine size={12} />
          Download
        </button>
      </div>
      {error && (
        <div className="log-error" role="alert">
          <TriangleAlert size={15} />
          {error}
          <Link href={env.runs.find((r) => String(r.id) === run)?.url}>
            Open workflow <ExternalLink size={12} />
          </Link>
        </div>
      )}
      <div
        className="log-console"
        ref={consoleRef}
        onScroll={() => {
          const el = consoleRef.current;
          if (el && el.scrollHeight - el.scrollTop - el.clientHeight > 60)
            setFollow(false);
        }}
      >
        {!logs && !error ? (
          <div className="console-empty">
            {paused
              ? "Fetching is paused. Resume to load output."
              : "Loading available output…"}
          </div>
        ) : lines.length ? (
          lines.map((l, i) => (
            <div
              className={`log-line ${/\b(ERROR|CRITICAL|FAIL)\b/i.test(l.text) ? "error-line" : /\bWARN(ING)?\b/i.test(l.text) ? "warning-line" : ""}`}
              key={i}
            >
              <span className="line-number">{i + 1}</span>
              {source !== "runtime" && (
                <span className="log-stage">{l.stage}</span>
              )}
              <span>{l.text || " "}</span>
            </div>
          ))
        ) : (
          !error && (
            <div className="console-empty">
              No output matches this selection.
            </div>
          )
        )}
      </div>
      <div className="log-note">
        <CircleHelp size={12} />
        {logs?.note ?? "Output is fetched only while this view is open."}
      </div>
    </section>
  );
}
function Monitor({ env }: { env: Environment }) {
  return (
    <div className="settings-content">
      <div className="section-heading">
        <h2>Runtime overview</h2>
        <p>Current service observations from Komodo</p>
      </div>
      <div className="service-table">
        <div className="table-head">
          <span>Service</span>
          <span>State</span>
          <span>Image</span>
        </div>
        {env.services.map((s) => (
          <div key={s.name}>
            <strong>
              <Box size={14} />
              {s.name}
            </strong>
            <span>
              <Dot state={s.state === "Running" ? "healthy" : "unknown"} />
              {s.state}
            </span>
            <code title={s.image}>{s.image}</code>
          </div>
        ))}
      </div>
      {!env.services.length && (
        <Empty title="No services available">
          This branch has no configured deployment, or Komodo data is
          unavailable.
        </Empty>
      )}
      <p className="muted">
        Exited migration and neutralization services can be expected one-shot
        completions. Their exit status must be verified in deployment logs.
      </p>
    </div>
  );
}
function Settings({
  env,
  project,
  theme,
  setTheme,
}: {
  env: Environment;
  project: Project;
  theme: string;
  setTheme: (v: string) => void;
}) {
  const rows = [
    [
      project.sourceKind === "infrastructure"
        ? "Deployment repository"
        : "Application repository",
      project.repository || "Not identified",
    ],
    [
      project.sourceKind === "infrastructure"
        ? "Deployment branch"
        : "Application branch",
      env.branch,
    ],
    ["Komodo stack", env.stack ?? "Not configured"],
    ["Odoo version", env.version],
    ["Observed service image", env.observedImage ?? "Not reported"],
  ];
  return (
    <div className="settings-content">
      <div className="section-heading">
        <h2>Environment settings</h2>
        <p>
          Safe configuration summary · managed through .env and infrastructure
          Git
        </p>
      </div>
      <dl className="settings-grid">
        {rows.map(([label, value]) => (
          <React.Fragment key={label}>
            <dt>{label}</dt>
            <dd>
              <code>{value}</code>
            </dd>
          </React.Fragment>
        ))}
      </dl>
      <div className="section-heading">
        <h2>Display preferences</h2>
        <p>Stored in this browser only</p>
      </div>
      <div className="preference">
        <div>
          <strong>Theme</strong>
          <p>Choose how this workspace looks on this device.</p>
        </div>
        <select
          value={theme}
          onChange={(e) => setTheme(e.target.value)}
          aria-label="Theme"
        >
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </div>
      <div className="preference">
        <div>
          <strong>Reset local preferences</strong>
          <p>Removes theme, branch selection, and collapsed groups.</p>
        </div>
        <button
          onClick={() => {
            try {
              Object.keys(localStorage)
                .filter((k) => k.startsWith("odoo-dashboard:v1:"))
                .forEach((k) => localStorage.removeItem(k));
            } catch {}
            location.assign(location.pathname);
          }}
        >
          Reset preferences
        </button>
      </div>
    </div>
  );
}
function Status({
  snapshot,
  onSelect,
  refreshError,
}: {
  snapshot: Snapshot;
  refreshError?: string;
  onSelect: (e: Environment) => void;
}) {
  return (
    <main className="status-page">
      <h2 className="status-section-label">Provider connections</h2>
      <div className="provider-grid">
        {snapshot.providers.map((p) => (
          <div className="provider-card" key={p.name}>
            <div className="provider-icon">
              {p.name === "Forgejo" ? (
                <GitBranch size={21} />
              ) : (
                <Layers3 size={21} />
              )}
            </div>
            <div>
              <strong>{p.name}</strong>
              <small>
                {refreshError
                  ? "Status unknown — refresh failed"
                  : p.state === "test" || p.state === "unchecked"
                    ? "Not checked"
                    : p.state === "connected"
                      ? "Healthy"
                      : "Partial or unavailable"}
              </small>
              {refreshError ? (
                <p className="provider-diagnostic">{refreshError}</p>
              ) : (
                !!p.issues?.length && (
                  <ul className="provider-diagnostics">
                    {p.issues.map((issue) => (
                      <li key={issue}>{issue}</li>
                    ))}
                  </ul>
                )
              )}
              {p.state !== "test" && p.state !== "unchecked" && (
                <small>
                  Last checked: {new Date(p.checkedAt).toLocaleString()}
                </small>
              )}
            </div>
            <Dot
              state={
                refreshError || p.state === "test" || p.state === "unchecked"
                  ? "unknown"
                  : p.state === "unavailable"
                    ? "warning"
                    : "healthy"
              }
            />
          </div>
        ))}
      </div>
      <h2 className="status-section-label">Odoo environments</h2>
      <div className="environment-table">
        <div className="table-head">
          <span>Environment / branch</span>
          <span>Runtime</span>
          <span>Latest attempt</span>
          <span />
        </div>
        {snapshot.projects
          .flatMap((p) => p.environments)
          .map((e) => (
            <div key={e.id}>
              <strong>
                <GitBranch size={14} />
                {e.branch}
                <small>
                  {e.stage === "Unknown" ? "Unclassified" : e.stage}
                </small>
              </strong>
              <span>
                <Dot state={e.health} />
                {e.health}
              </span>
              {e.attempts[0] ? (
                <Badge state={e.attempts[0].state} />
              ) : (
                <span className="muted">No deployment</span>
              )}
              <button onClick={() => onSelect(e)}>
                View <ArrowRight size={13} />
              </button>
            </div>
          ))}
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <LoginGate pending={<DashboardLoading />}>
    {(user, logout) => <App user={user} onLogout={logout} />}
  </LoginGate>,
);
