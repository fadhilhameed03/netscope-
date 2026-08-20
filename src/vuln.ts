import { invoke } from "@tauri-apps/api/core";
import type { HostInfo, VulnInfo } from "./types";

export async function checkVulnerabilities(
  hosts: HostInfo[]
): Promise<Record<string, VulnInfo[]>> {
  return invoke<Record<string, VulnInfo[]>>("check_vulnerabilities", { hosts });
}