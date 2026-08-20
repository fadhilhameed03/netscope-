import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import type { HostInfo } from "./types";

export async function exportAsTxt(hosts: HostInfo[], target: string) {
  const lines: string[] = [
    `NetScope Scan Report`,
    `Target: ${target}`,
    `Scanned: ${new Date().toISOString()}`,
    `Hosts up: ${hosts.length}`,
    "",
  ];

  for (const h of hosts) {
    lines.push(`${h.ip}${h.hostname ? ` (${h.hostname})` : ""} — ${h.state}`);
    lines.push(`  OS: ${h.os}`);
    lines.push(`  MAC: ${h.mac || "—"} ${h.vendor ? `(${h.vendor})` : ""}`);
    if (h.ports.length === 0) {
      lines.push(`  No open ports.`);
    } else {
      for (const p of h.ports) {
        lines.push(`  ${p.port}/${p.protocol} ${p.state} ${p.service} ${p.product} ${p.version}`.trimEnd());
      }
    }
    lines.push("");
  }

  const path = await save({
    defaultPath: `netscope_scan_${Date.now()}.txt`,
    filters: [{ name: "Text", extensions: ["txt"] }],
  });
  if (!path) return;
  await writeTextFile(path, lines.join("\n"));
}

export async function exportAsJson(hosts: HostInfo[], target: string) {
  const payload = {
    target,
    scannedAt: new Date().toISOString(),
    hostCount: hosts.length,
    hosts,
  };
  const path = await save({
    defaultPath: `netscope_scan_${Date.now()}.json`,
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (!path) return; // user cancelled
  await writeTextFile(path, JSON.stringify(payload, null, 2));
}

export async function exportAsCsv(hosts: HostInfo[]) {
  const rows: string[] = ["IP,Hostname,OS,MAC,Vendor,Port,Protocol,State,Service,Product,Version"];

  for (const h of hosts) {
    if (h.ports.length === 0) {
      rows.push(
        [h.ip, h.hostname, h.os, h.mac, h.vendor, "", "", "", "", "", ""]
          .map(csvEscape)
          .join(",")
      );
    } else {
      for (const p of h.ports) {
        rows.push(
          [h.ip, h.hostname, h.os, h.mac, h.vendor, p.port, p.protocol, p.state, p.service, p.product, p.version]
            .map(csvEscape)
            .join(",")
        );
      }
    }
  }

  const path = await save({
    defaultPath: `netscope_scan_${Date.now()}.csv`,
    filters: [{ name: "CSV", extensions: ["csv"] }],
  });
  if (!path) return;
  await writeTextFile(path, rows.join("\n"));
}

function csvEscape(value: string | number): string {
  const str = String(value ?? "");
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}