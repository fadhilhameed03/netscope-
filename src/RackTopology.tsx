import { useEffect, useRef, useState, useLayoutEffect } from "react";
import type { HostInfo } from "./types";

interface Props {
  hosts: HostInfo[];
  selectedIp: string | null;
  onSelectHost: (ip: string | null) => void;
}

interface ZoneBoxes {
  gateway: HostInfo[];
  self: HostInfo[];
  others: HostInfo[];
}

function classifyHosts(hosts: HostInfo[]): ZoneBoxes {
  const gateway: HostInfo[] = [];
  const self: HostInfo[] = [];
  const others: HostInfo[] = [];

  for (const h of hosts) {
    const hostnameLower = h.hostname.toLowerCase();
    const lastOctet = h.ip.split(".").pop();

    if (hostnameLower.includes("gateway") || lastOctet === "1") {
      gateway.push(h);
    } else if (hostnameLower.includes("kali")) {
      self.push(h);
    } else {
      others.push(h);
    }
  }

  return { gateway, self, others };
}

interface LinePos {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export default function RackTopology({ hosts, selectedIp, onSelectHost }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const hubRef = useRef<HTMLDivElement>(null);
  const gatewayRef = useRef<HTMLDivElement>(null);
  const selfRef = useRef<HTMLDivElement>(null);
  const othersRef = useRef<HTMLDivElement>(null);

  const [lines, setLines] = useState<LinePos[]>([]);

  const zones = classifyHosts(hosts);

  function computeLines() {
    const container = containerRef.current;
    const hub = hubRef.current;
    if (!container || !hub) return;

    const containerRect = container.getBoundingClientRect();
    const hubRect = hub.getBoundingClientRect();
    const hubCenter = {
      x: hubRect.left + hubRect.width / 2 - containerRect.left,
      y: hubRect.top + hubRect.height / 2 - containerRect.top,
    };

    const newLines: LinePos[] = [];
    const refs = [
      { ref: gatewayRef, hasContent: zones.gateway.length > 0 },
      { ref: selfRef, hasContent: zones.self.length > 0 },
      { ref: othersRef, hasContent: zones.others.length > 0 },
    ];

    for (const { ref, hasContent } of refs) {
      if (!hasContent || !ref.current) continue;
      const boxRect = ref.current.getBoundingClientRect();
      const boxCenter = {
        x: boxRect.left + boxRect.width / 2 - containerRect.left,
        y: boxRect.top - containerRect.top, // connect to top edge of box
      };
      newLines.push({ x1: hubCenter.x, y1: hubCenter.y, x2: boxCenter.x, y2: boxCenter.y });
    }

    setLines(newLines);
  }

  useLayoutEffect(() => {
    computeLines();
  }, [hosts]);

  useEffect(() => {
    const handleResize = () => computeLines();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [hosts]);

  function renderHostChip(h: HostInfo) {
    const riskyPorts = h.ports.filter((p) => p.state === "open").length;
    return (
      <div
        key={h.ip}
        onClick={() => onSelectHost(h.ip)}
        className={`rack-chip ${selectedIp === h.ip ? "rack-chip-active" : ""}`}
      >
        <div className="rack-chip-ip">{h.ip}</div>
        {h.hostname && <div className="rack-chip-hostname">{h.hostname}</div>}
        <div className="rack-chip-ports">{riskyPorts} open ports</div>
      </div>
    );
  }

  return (
    <div className="rack-topology" ref={containerRef}>
      <svg className="rack-lines-svg">
        {lines.map((l, i) => (
          <line
            key={i}
            x1={l.x1}
            y1={l.y1}
            x2={l.x2}
            y2={l.y2}
            stroke="#3fae7a"
            strokeWidth={2}
            strokeDasharray="6,5"
            opacity={0.6}
          />
        ))}
      </svg>

      <div className="rack-hub" ref={hubRef}>
        <div className="rack-hub-label">Network</div>
      </div>

      <div className="rack-zones">
        {zones.gateway.length > 0 && (
          <div className="rack-zone rack-zone-gateway" ref={gatewayRef}>
            <div className="rack-zone-title">Gateway / Router</div>
            <div className="rack-zone-chips">{zones.gateway.map(renderHostChip)}</div>
          </div>
        )}

        {zones.self.length > 0 && (
          <div className="rack-zone rack-zone-self" ref={selfRef}>
            <div className="rack-zone-title">This Machine</div>
            <div className="rack-zone-chips">{zones.self.map(renderHostChip)}</div>
          </div>
        )}

        {zones.others.length > 0 && (
          <div className="rack-zone rack-zone-others" ref={othersRef}>
            <div className="rack-zone-title">Network Hosts</div>
            <div className="rack-zone-chips">{zones.others.map(renderHostChip)}</div>
          </div>
        )}
      </div>
    </div>
  );
}