import { useState, useEffect, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { NucleiFinding, NUCLEI_TAGS } from "./types";
import { openUrl } from "@tauri-apps/plugin-opener";

interface ProgressEvent {
  message: string;
}

const SEVERITY_COLOR: Record<string, string> = {
  critical: "#ff4d4f",
  high: "#ff7a45",
  medium: "#faad14",
  low: "#52c41a",
  info: "#8c8c8c",
};

function severityColor(sev: string): string {
  return SEVERITY_COLOR[sev.toLowerCase()] ?? "#8c8c8c";
}

export default function NucleiPage() {
  const [target, setTarget] = useState("");
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const [findings, setFindings] = useState<NucleiFinding[]>([]);
  const logBodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const unlisten = listen<ProgressEvent>("nuclei-progress", (event) => {
      setLog((prev) => [...prev.slice(-100), event.payload.message]);
    });
    return () => { unlisten.then((f) => f()); };
  }, []);

  useEffect(() => {
    const unlisten = listen<NucleiFinding>("nuclei-finding", (event) => {
      setFindings((prev) => [...prev, event.payload]);
    });
    return () => { unlisten.then((f) => f()); };
  }, []);

  useEffect(() => {
    if (logBodyRef.current) {
      logBodyRef.current.scrollTop = logBodyRef.current.scrollHeight;
    }
  }, [log]);

  function toggleTag(tag: string) {
    setSelectedTags((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) {
        next.delete(tag);
      } else {
        next.add(tag);
      }
      return next;
    });
  }

  async function handleScan(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    setLog([]);
    setFindings([]);
    try {
      // Findings arrive live via the "nuclei-finding" event as the scan
      // runs — the return value here is the same final list, so we don't
      // need to use it directly (avoids double-adding to state).
      await invoke<NucleiFinding[]>("nuclei_scan", {
        target,
        tags: selectedTags.size > 0 ? Array.from(selectedTags).join(",") : null,
      });
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  function openReference(url: string) {
    openUrl(url).catch((err) => {
      console.error("Failed to open reference link:", err);
    });
  }

  const severityCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const f of findings) {
      const sev = f.severity.toLowerCase();
      counts[sev] = (counts[sev] ?? 0) + 1;
    }
    return counts;
  }, [findings]);

  const tagArg = selectedTags.size > 0 ? Array.from(selectedTags).join(",") : null;

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-header-icon">☢</div>
        <div>
          <h1 className="page-title">Nuclei Scanner</h1>
          <p className="page-subtitle">
            Template-based vulnerability scanning via nuclei. Findings stream in live as they're matched.
          </p>
        </div>
      </div>

      <form onSubmit={handleScan}>
        <div className="scan-form-row">
          <input
            type="text"
            placeholder="Target URL or host (e.g. https://example.com)"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            required
            className="target-input"
          />
          <button type="submit" disabled={loading} className="scan-btn">
            {loading ? "Scanning..." : "Scan"}
          </button>
        </div>

        <div className="command-row">
          <span className="command-label">Command:</span>
          <span className="command-fixed">nuclei -u</span>
          <span className="command-fixed">{target || "<target>"}</span>
          <span className="command-fixed">-jsonl -silent{tagArg ? ` -tags ${tagArg}` : ""}</span>
        </div>

        <div style={{ marginTop: "12px" }}>
          <p style={{ color: "#7fbf9f", fontSize: "13px", margin: "0 0 8px" }}>
            Template tags {selectedTags.size === 0 ? "(none selected — runs nuclei's default set)" : `(${selectedTags.size} selected)`}
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
            {NUCLEI_TAGS.map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() => toggleTag(tag)}
                className={`view-toggle-btn ${selectedTags.has(tag) ? "view-toggle-btn-active" : ""}`}
              >
                {tag}
              </button>
            ))}
          </div>
        </div>
      </form>

      {error && <div className="error-banner" style={{ marginTop: "14px" }}>Error: {error}</div>}

      {(loading || log.length > 0) && (
        <div className="terminal-panel" style={{ marginTop: "16px" }}>
          <div className="terminal-header">
            <span className="term-dot term-dot-red" />
            <span className="term-dot term-dot-yellow" />
            <span className="term-dot term-dot-green" />
            <span className="terminal-title">
              root@netscope: ~/nuclei — {loading ? "scanning" : "done"}
            </span>
          </div>
          <div className="terminal-body" ref={logBodyRef}>
            {log.map((line, i) => (
              <div key={i} className="terminal-line">
                <span className="terminal-prompt">$</span> {line}
              </div>
            ))}
            {loading && (
              <div className="terminal-cursor-line">
                <span className="terminal-prompt">$</span> <span className="blink-cursor">▊</span>
              </div>
            )}
          </div>
        </div>
      )}

      {findings.length > 0 && (
        <div className="side-panel" style={{ marginTop: "16px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "10px" }}>
            <p style={{ color: "#7fbf9f", margin: 0 }}>
              {findings.length} finding{findings.length !== 1 ? "s" : ""}
            </p>
            <div style={{ display: "flex", gap: "10px" }}>
              {Object.entries(severityCounts).map(([sev, count]) => (
                <span
                  key={sev}
                  style={{
                    color: severityColor(sev),
                    border: `1px solid ${severityColor(sev)}`,
                    borderRadius: "4px",
                    padding: "2px 8px",
                    fontSize: "12px",
                    textTransform: "uppercase",
                  }}
                >
                  {sev}: {count}
                </span>
              ))}
            </div>
          </div>

          <table className="ettercap-host-table">
            <thead>
              <tr>
                <th>Severity</th>
                <th>Name</th>
                <th>Template</th>
                <th>Host</th>
                <th>CVE</th>
              </tr>
            </thead>
            <tbody>
              {findings.map((f, i) => (
                <tr key={`${f.template_id}-${f.matched_at}-${i}`}>
                  <td>
                    <span
                      style={{
                        color: severityColor(f.severity),
                        border: `1px solid ${severityColor(f.severity)}`,
                        borderRadius: "4px",
                        padding: "1px 6px",
                        fontSize: "11px",
                        textTransform: "uppercase",
                      }}
                    >
                      {f.severity}
                    </span>
                  </td>
                  <td>{f.name}</td>
                  <td>{f.template_id}</td>
                  <td>{f.matched_at || f.host}</td>
                  <td>
                    {f.cve_id ? (
                      <button
                        type="button"
                        onClick={() => openReference(`https://nvd.nist.gov/vuln/detail/${f.cve_id}`)}
                        style={{ background: "none", border: "none", color: "#4dabf7", cursor: "pointer", padding: 0 }}
                      >
                        {f.cve_id}
                      </button>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!loading && findings.length === 0 && log.length > 0 && !error && (
        <div className="side-panel" style={{ marginTop: "16px" }}>
          <p style={{ color: "#7fbf9f", margin: 0 }}>
            Scan complete — no findings matched for the selected tags.
          </p>
        </div>
      )}
    </div>
  );
}