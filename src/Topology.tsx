import { useEffect, useRef } from "react";
import { Network } from "vis-network";
import { DataSet } from "vis-data";
import type { HostInfo } from "./types";

interface Props {
  hosts: HostInfo[];
  scanTarget: string;
  selectedIp: string | null;
  onSelectHost: (ip: string | null) => void;
}

function classifyHost(host: HostInfo): { color: string; icon: string } {
  const services = host.ports.map((p) => p.service.toLowerCase());
  const hostnameLower = host.hostname.toLowerCase();
  const lastOctet = host.ip.split(".").pop();

  if (hostnameLower.includes("gateway") || lastOctet === "1") return { color: "#c9a227", icon: "📡" };
  if (services.some((s) => s.includes("http"))) return { color: "#2e7d5b", icon: "🌐" };
  if (services.some((s) => s.includes("print") || s.includes("ipp"))) return { color: "#8b2f2f", icon: "🖨" };
  if (services.some((s) => s.includes("ssh"))) return { color: "#5a7dc9", icon: "💻" };
  if (host.ports.length === 0) return { color: "#2e6d7d", icon: "❔" };
  return { color: "#2e7d5b", icon: "🖥" };
}

export default function Topology({ hosts, selectedIp, onSelectHost }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const networkRef = useRef<Network | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    try {
      const seen = new Set<string>();
      const uniqueHosts = hosts.filter((h) => {
        if (seen.has(h.ip)) return false;
        seen.add(h.ip);
        return true;
      });

      const nodes = new DataSet<any>([
        {
          id: "scanner",
          label: "🛰️\nScanner (you)",
          shape: "dot",
          color: { background: "#c9a227", border: "#ffffff33" },
          font: { color: "#fff", size: 13 },
          size: 32,
          shadow: { enabled: true, color: "#c9a22799", size: 20, x: 0, y: 0 },
        },
        ...uniqueHosts.map((h) => {
          const { color } = classifyHost(h);
          const nameLine = h.hostname ? `${h.hostname}\n${h.ip}` : h.ip;
          return {
            id: h.ip,
            label: nameLine,
            shape: "dot",
            color: {
              background: color,
              border: "#ffffffaa",
              highlight: { background: color, border: "#7fffb0" },
            },
            font: { color: "#e8f5ee", size: 12 },
            size: 26,
            borderWidth: 3,
            shadow: { enabled: true, color: color + "aa", size: 16, x: 0, y: 0 },
          };
        }),
      ]);

      const edges = new DataSet<any>(
        uniqueHosts.map((h) => ({
          from: "scanner",
          to: h.ip,
          dashes: true,
          color: { color: "#3fae7a", opacity: 0.7 },
          width: 2,
        }))
      );

      const options = {
        layout: { improvedLayout: false },
        physics: {
          enabled: true,
          stabilization: { iterations: 60, fit: true },
          solver: "forceAtlas2Based",
          forceAtlas2Based: { gravitationalConstant: -50, springLength: 100, springConstant: 0.08 },
        },
        interaction: { hover: true, tooltipDelay: 100 },
        nodes: { borderWidth: 2, shadow: false },
        edges: { shadow: false, smooth: false },
      };

      const network = new Network(containerRef.current, { nodes, edges }, options);

      network.once("stabilizationIterationsDone", () => {
        network.setOptions({ physics: { enabled: false } });
      });

      const physicsOffTimer = setTimeout(() => {
        network.setOptions({ physics: { enabled: false } });
      }, 800);

      network.on("click", (params) => {
        if (params.nodes.length > 0) {
          const id = params.nodes[0];
          if (id !== "scanner") onSelectHost(id);
        } else {
          onSelectHost(null);
        }
      });

      networkRef.current = network;

      return () => {
        clearTimeout(physicsOffTimer);
        network.destroy();
        networkRef.current = null;
      };
    } catch (err) {
      console.error("Topology render error:", err);
      if (containerRef.current) {
        containerRef.current.innerHTML = `<div style="color:#ff6b6b;padding:20px;font-family:monospace;">Topology render failed: ${String(err)}</div>`;
      }
    }
  }, [hosts]);

  useEffect(() => {
    if (!networkRef.current) return;
    if (selectedIp) {
      try {
        networkRef.current.selectNodes([selectedIp]);
      } catch {
        // node might not exist in this graph yet — ignore
      }
    } else {
      networkRef.current.unselectAll();
    }
  }, [selectedIp]);

  return (
    <div
      style={{
        background: "#0a0e14",
        backgroundImage:
          "linear-gradient(rgba(63,174,122,0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(63,174,122,0.08) 1px, transparent 1px)",
        backgroundSize: "20px 20px",
        border: "1px solid #1e2a1e",
        borderRadius: "8px",
        height: "500px",
        width: "100%",
      }}
    >
      <div ref={containerRef} style={{ height: "100%", width: "100%" }} />
    </div>
  );
}