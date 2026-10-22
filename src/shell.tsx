import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import {
  ExternalLink,
  Plug,
  TerminalSquare,
  TriangleAlert,
  Unplug,
  Square,
} from "lucide-react";
import type { Project, Environment, ClientSocketStatus } from "./types.ts";
import "@xterm/xterm/css/xterm.css";
export function Shell({
  project,
  env,
  onSocketStatus,
}: {
  project: Project;
  env: Environment;
  onSocketStatus: (status: ClientSocketStatus) => void;
}) {
  const host = useRef<HTMLDivElement>(null),
    terminal = useRef<Terminal | null>(null),
    fit = useRef<FitAddon | null>(null),
    ws = useRef<WebSocket | null>(null),
    session = useRef("");
  const [state, setState] = useState("Disconnected"),
    [error, setError] = useState("");
  const disconnect = () => {
    ws.current?.close();
    ws.current = null;
    setState("Disconnected");
    onSocketStatus("Disconnected");
  };
  useEffect(() => {
    onSocketStatus("Idle");
    const t = new Terminal({
      theme: {
        background: "#202329",
        foreground: "#d7dce4",
        cursor: "#77c7c0",
      },
      fontFamily: '"SFMono-Regular", Consolas, monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 3000,
      allowProposedApi: false,
    });
    const f = new FitAddon();
    t.loadAddon(f);
    t.open(host.current!);
    f.fit();
    terminal.current = t;
    fit.current = f;
    t.writeln("\x1b[90mKomodo-backed terminal · " + env.branch + "\x1b[0m\r\n");
    t.writeln("Connect to open an interactive shell in the selected service.");
    const input = t.onData((data) => {
      if (ws.current?.readyState === WebSocket.OPEN && ws.current.datasetReady)
        ws.current.send(JSON.stringify({ type: "input", data }));
    });
    const resize = t.onResize(({ rows, cols }) => {
      if (ws.current?.readyState === WebSocket.OPEN && ws.current.datasetReady)
        ws.current.send(JSON.stringify({ type: "resize", rows, cols }));
    });
    const observer = new ResizeObserver(() => {
      try {
        f.fit();
      } catch {}
    });
    observer.observe(host.current!);
    return () => {
      ws.current?.close();
      ws.current = null;
      onSocketStatus("Idle");
      session.current = "";
      observer.disconnect();
      input.dispose();
      resize.dispose();
      t.dispose();
      terminal.current = null;
    };
  }, [project.id, env.id, onSocketStatus]);
  const connect = () => {
    if (!env.terminal || !terminal.current) return;
    disconnect();
    setError("");
    setState("Connecting");
    onSocketStatus("Connecting");
    const query = new URLSearchParams({
      project: project.id,
      environment: env.id,
      ...(session.current ? { session: session.current } : {}),
    });
    let ended = false;
    let failed = false;
    const socket = new WebSocket(
      `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/terminal?${query}`,
    );
    socket.binaryType = "arraybuffer";
    ws.current = socket;
    socket.onopen = () => {
      if (ws.current === socket) onSocketStatus("Connected");
    };
    socket.onmessage = (event) => {
      if (ws.current !== socket) return;
      if (event.data instanceof ArrayBuffer) {
        terminal.current?.write(new Uint8Array(event.data));
        return;
      }
      try {
        const m = JSON.parse(event.data);
        if (m.type === "ready") {
          socket.datasetReady = true;
          session.current = m.session;
          setState("Connected");
          terminal.current?.clear();
          fit.current?.fit();
          socket.send(
            JSON.stringify({
              type: "resize",
              rows: terminal.current!.rows,
              cols: terminal.current!.cols,
            }),
          );
          terminal.current?.focus();
        } else if (m.type === "ended") {
          ended = true;
          session.current = "";
          setState("Disconnected");
          terminal.current?.writeln("\r\n[Session ended]");
        } else if (m.type === "error") {
          failed = true;
          onSocketStatus("Error");
          setError(m.message);
        }
      } catch {
        failed = true;
        onSocketStatus("Error");
        setError("Unsupported terminal response");
        socket.close();
      }
    };
    socket.onclose = () => {
      if (ws.current !== socket) return;
      setState("Disconnected");
      onSocketStatus(failed ? "Error" : "Disconnected");
      if (!ended)
        terminal.current?.writeln(
          "\r\n\x1b[90m[Disconnected — Komodo session may still be running]\x1b[0m",
        );
    };
    socket.onerror = () => {
      if (ws.current !== socket) return;
      failed = true;
      onSocketStatus("Error");
      setError(
        "Connection failed. Check access, target state, and Komodo compatibility.",
      );
    };
  };
  return (
    <section className="shell-view">
      {env.stage !== "Staging" && (
        <div
          className={`shell-notice ${env.stage === "Production" ? "production-notice" : ""}`}
        >
          <TriangleAlert size={16} />
          <span>
            <strong>
              {env.stage === "Unknown" ? "Unclassified" : env.stage} shell.
            </strong>{" "}
            Commands can modify files, processes, and database contents.
          </span>
        </div>
      )}
      <div className="shell-toolbar">
        <TerminalSquare size={16} />
        <strong>
          {env.stack ?? "No stack"}{" "}
          <span className="muted">
            / {env.terminalService || "Service not identified"}
          </span>
        </strong>
        <span className="connection-state">{state}</span>
        {env.komodoTerminalsUrl && (
          <a href={env.komodoTerminalsUrl} target="_blank" rel="noreferrer">
            Open in Komodo <ExternalLink size={12} />
          </a>
        )}
        {state === "Disconnected" ? (
          <button disabled={!env.terminal} onClick={connect}>
            <Plug size={14} />
            {session.current ? "Reconnect" : "Connect"}
          </button>
        ) : (
          <button onClick={disconnect}>
            <Unplug size={14} />
            Disconnect
          </button>
        )}
        {state === "Connected" && (
          <button
            onClick={() => ws.current?.send(JSON.stringify({ type: "end" }))}
          >
            <Square size={12} />
            End session
          </button>
        )}
      </div>
      {!env.terminal && (
        <div className="shell-disabled">
          <TerminalSquare size={22} />
          <div>
            <strong>Shell is not enabled for this target or identity</strong>
            <p>
              Shell is disabled by dashboard policy for this target or identity.
              When enabled, it uses the same Komodo account as deployment reads.
            </p>
          </div>
        </div>
      )}
      {error && (
        <p className="log-error" role="alert">
          {error}
          <button
            onClick={() => {
              session.current = "";
              setError("");
            }}
          >
            Use a new session
          </button>
        </p>
      )}
      <div ref={host} className="terminal-host" />
      <div className="log-note">
        Transport: dashboard WebSocket relay → Komodo Core → Periphery.
        Disconnect closes your connection; it does not terminate the shell
        process. No dashboard transcript is stored.
      </div>
    </section>
  );
}
declare global {
  interface WebSocket {
    datasetReady?: boolean;
  }
}
