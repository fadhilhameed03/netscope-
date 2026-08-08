import { useState, useEffect, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Topology from "./Topology";
import { HostInfo, SCAN_PROFILES, PROFILE_ARGS } from "./types";
import "./App.css";

interface ProgressEvent {
  message: string;
  percent: number | null;
}

function App() {
  const [target, setTarget] = useState("");
  const [profile, setProfile] = useState("ping_sweep");
  const [customArgs, setCustomArgs] = useState(PROFILE_ARGS["ping_sweep"]);
  const [hosts, setHosts] = useState<HostInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selectedIp, setSelectedIp] = useState<string | null>(null);
  const [progressLog, setProgressLog] = useState<string[]>([]);
  const [percent, setPercent] = useState<number | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const unlisten = listen<ProgressEvent>("scan-progress", (event) => {
      setProgressLog((prev) => [...prev.slice(-50), event.payload.message]);
      if (event.payload.percent !== null) {
        setPercent(event.payload.percent);
      }
    });
    return () => { unlisten.then((f) => f()); };
  }, []);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [progressLog]);

  function handleProfileChange(newProfile: string) {
    setProfile(newProfile);
    setCustomArgs(PROFILE_ARGS[newProfile] ?? "-T4 -F"); // reset command field to match the picked profile
  }

  async function handleScan(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    setHosts([]);
    setSelectedIp(null);
    setProgressLog([]);
    setPercent(0);
    try {
      const result = await invoke<HostInfo[]>("scan_network", {
        target,
        profile,
        customArgs: customArgs.trim() || null,
      });
      setHosts(result);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
      setPercent(null);
    }
  }

  const upHosts = useMemo(() => hosts.filter((h) => h.state === "up"), [hosts]);
  const selectedHost = upHosts.find((h) => h.ip === selectedIp) || null;

  const terminalPanel = (
    <div className="terminal-panel">
      <div className="terminal-header">
        <span className="term-dot term-dot-red" />
        <span className="term-dot term-dot-yellow" />
        <span className="term-dot term-dot-green" />
        <span className="terminal-title">
          root@netscope: ~/scan — {percent !== null ? `${percent.toFixed(1)}%` : loading ? "..." : "done"}
        </span>
      </div>
      <div className="terminal-progress-track">
        <div className="terminal-progress-fill" style={{ width: `${percent ?? 100}%` }} />
      </div>
      <div className="terminal-body">
        {progressLog.map((line, i) => (
          <div key={i} className="terminal-line">
            <span className="terminal-prompt">$</span> {line}
          </div>
        ))}
        {loading && (
          <div className="terminal-cursor-line">
            <span className="terminal-prompt">$</span> <span className="blink-cursor">▊</span>
          </div>
        )}
        <div ref={logEndRef} />
      </div>
    </div>
  );

  return (
    <div style={{ background: "#0a0e14", minHeight: "100vh", color: "#e0e0e0", padding: "24px", fontFamily: "sans-serif" }}>
      <h1 style={{ color: "#3fae7a" }}>NetScope</h1>

      <form onSubmit={handleScan}>
        <div style={{ display: "flex", gap: "12px", marginBottom: "10px", flexWrap: "wrap" }}>
          <input
            type="text"
            placeholder="Target IP or range (e.g. 192.168.1.0/24)"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            required
            style={{ padding: "8px", flex: "1", minWidth: "220px", background: "#141a14", color: "#fff", border: "1px solid #2e7d5b" }}
          />
          <select
            value={profile}
            onChange={(e) => handleProfileChange(e.target.value)}
            style={{ padding: "8px", background: "#141a14", color: "#fff", border: "1px solid #2e7d5b" }}
          >
            {SCAN_PROFILES.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
          <button
            type="submit"
            disabled={loading}
            style={{ padding: "8px 20px", background: "#2e7d5b", color: "#fff", border: "none", borderRadius: "4px", cursor: "pointer" }}
          >
            {loading ? "Scanning..." : "Scan"}
          </button>
        </div>

        {/* Zenmap-style editable command bar */}
        <div className="command-row">
          <span className="command-label">Command:</span>
          <span className="command-fixed">nmap</span>
          <input
            type="text"
            value={customArgs}
            onChange={(e) => setCustomArgs(e.target.value)}
            className="command-input"
            spellCheck={false}
          />
          <span className="command-fixed">{target || "<target>"}</span>
        </div>
      </form>

      {error && <div style={{ color: "#ff6b6b", margin: "16px 0" }}>Error: {error}</div>}

      {/* Before any results exist yet, show the terminal full-width if a scan is running */}
      {upHosts.length === 0 && loading && <div style={{ marginTop: "16px" }}>{terminalPanel}</div>}

      {upHosts.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 360px", gap: "20px", alignItems: "start", marginTop: "16px" }}>
          {/* LEFT: graph, then terminal log right below it */}
          <div>
            <Topology
              hosts={upHosts}
              scanTarget={target}
              selectedIp={selectedIp}
              onSelectHost={setSelectedIp}
            />
            <div style={{ marginTop: "16px" }}>{terminalPanel}</div>
          </div>

          {/* RIGHT: hosts found list on top, selected host details below */}
          <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            <div className="side-panel">
              <h3 style={{ marginTop: 0, color: "#3fae7a" }}>
                Hosts found: {upHosts.length} up / {hosts.length} scanned
              </h3>
              <div style={{ maxHeight: "260px", overflowY: "auto" }}>
                {upHosts.map((h) => (
                  <div
                    key={h.ip}
                    onClick={() => setSelectedIp(h.ip)}
                    className={`host-row ${selectedIp === h.ip ? "host-row-active" : ""}`}
                  >
                    <strong>{h.ip}</strong> {h.hostname && `(${h.hostname})`}
                    <div style={{ fontSize: "12px", color: "#7fbf9f" }}>{h.ports.length} open ports</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="side-panel" style={{ maxHeight: "50vh", overflowY: "auto" }}>
              {selectedHost ? (
                <>
                  <h3 style={{ color: "#3fae7a", marginTop: 0 }}>{selectedHost.ip}</h3>
                  {selectedHost.hostname && (
                    <p style={{ color: "#9fbfae", marginTop: "-8px" }}>{selectedHost.hostname}</p>
                  )}
                  <p><span style={{ color: "#7fbf9f" }}>OS:</span> {selectedHost.os}</p>
                  <p>
                    <span style={{ color: "#7fbf9f" }}>MAC:</span> {selectedHost.mac || "—"}{" "}
                    {selectedHost.vendor && `(${selectedHost.vendor})`}
                  </p>
                  <h4 style={{ color: "#3fae7a", marginBottom: "8px" }}>
                    Open Ports ({selectedHost.ports.length})
                  </h4>
                  {selectedHost.ports.length === 0 ? (
                    <p style={{ color: "#666" }}>No open ports detected.</p>
                  ) : (
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
                      <thead>
                        <tr style={{ borderBottom: "1px solid #2e7d5b", textAlign: "left" }}>
                          <th style={{ padding: "4px 6px" }}>Port</th>
                          <th style={{ padding: "4px 6px" }}>Service</th>
                          <th style={{ padding: "4px 6px" }}>Version</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedHost.ports
                          .sort((a, b) => a.port - b.port)
                          .map((p) => (
                            <tr key={`${p.port}-${p.protocol}`} style={{ borderBottom: "1px solid #1e2a1e" }}>
                              <td style={{ padding: "4px 6px", color: "#3fae7a", fontFamily: "monospace" }}>
                                {p.port}/{p.protocol}
                              </td>
                              <td style={{ padding: "4px 6px" }}>{p.service || "—"}</td>
                              <td style={{ padding: "4px 6px", color: "#9fbfae" }}>
                                {p.product} {p.version}
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  )}
                </>
              ) : (
                <p style={{ color: "#666" }}>Click a machine in the graph or list to see its details here.</p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;