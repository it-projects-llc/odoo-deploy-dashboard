export type Stage = "Production" | "Staging" | "Development" | "Unknown";
export type Result =
  | "passed"
  | "warning"
  | "failed"
  | "running"
  | "pending"
  | "cancelled"
  | "skipped"
  | "unknown";
export interface Check {
  name: string;
  state: Result;
  url?: string;
  description?: string;
}
export interface Commit {
  sha: string;
  message: string;
  author: string;
  avatar?: string;
  date: string;
  url?: string;
  checks: Check[];
  result: Result;
}
export interface Run {
  id: number;
  name: string;
  sha: string;
  state: Result;
  url?: string;
  date: string;
}
export interface Attempt {
  id: string;
  state: Result;
  date: string;
  end?: string;
  operation: string;
  actor: string;
  infraSha?: string;
  url?: string;
}
export interface Service {
  name: string;
  state: string;
  image: string;
}
export interface Environment {
  id: string;
  name: string;
  branch: string;
  stage: Stage;
  version: string;
  stack?: string;
  url?: string;
  health:
    | "healthy"
    | "running"
    | "unhealthy"
    | "stopped"
    | "unknown"
    | "not deployed";
  commits: Commit[];
  runs: Run[];
  attempts: Attempt[];
  services: Service[];
  deployedInfraSha?: string;
  desiredImage?: string;
  deployedImage?: string;
  observedImage?: string;
  terminal: boolean;
  komodoTerminalsUrl?: string;
  terminalService?: string;
  issues: string[];
  nextCommitPage?: number;
  nextUpdatePage?: number;
}
export interface Project {
  id: string;
  name: string;
  sourceKind?: "application" | "infrastructure" | "none";
  repository: string;
  repoUrl?: string;
  notice?: string;
  environments: Environment[];
}
export interface ProviderState {
  name: string;
  state: "connected" | "unavailable" | "unchecked" | "test";
  checkedAt: string;
  issues?: string[];
}
export interface Snapshot {
  issues?: string[];
  workEnv: "test" | "prod";
  fetchedAt: string;
  stale: boolean;
  projects: Project[];
  providers: ProviderState[];
  pollMs: number;
  terminalEnabled: boolean;
}
export interface LogEntry {
  stage: string;
  text: string;
  success?: boolean;
}
export interface Logs {
  title: string;
  entries: LogEntry[];
  fetchedAt: string;
  note: string;
  stages?: string[];
}

export type ClientSocketStatus =
  | "Idle"
  | "Connecting"
  | "Connected"
  | "Disconnected"
  | "Error";
