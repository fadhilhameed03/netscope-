mod scan;
mod vuln;
mod exploit;
mod ettercap;
mod nuclei;
use scan::{parse_nmap_xml, run_nmap, HostInfo};
use vuln::{lookup_vulns, VulnInfo};
use exploit::{search_exploits, ExploitInfo};
use ettercap::{discover_hosts, start_mitm, stop_mitm, HostEntry};
use nuclei::{run_nuclei, NucleiFinding};
use std::collections::HashMap;
use std::process::Child;
use std::sync::Mutex;
use tauri::Emitter;

/// Holds the currently running ettercap MITM process, if any.
/// Only one MITM session is allowed at a time.
#[derive(Default)]
pub struct MitmState(pub Mutex<Option<Child>>);

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
async fn scan_network(
    app: tauri::AppHandle,
    target: String,
    profile: String,
    custom_args: Option<String>,
) -> Result<Vec<HostInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let xml = run_nmap(&app, &target, &profile, custom_args.as_deref())?;
        parse_nmap_xml(&xml)
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
async fn check_vulnerabilities(
    app: tauri::AppHandle,
    hosts: Vec<HostInfo>,
) -> Result<HashMap<String, Vec<VulnInfo>>, String> {
    let mut results: HashMap<String, Vec<VulnInfo>> = HashMap::new();

    let mut targets: Vec<(String, String, String)> = Vec::new();
    for host in &hosts {
        for port in &host.ports {
            if !port.product.trim().is_empty() {
                let key = format!("{}:{}", host.ip, port.port);
                targets.push((key, port.product.clone(), port.version.clone()));
            }
        }
    }

    let total = targets.len();
    if total == 0 {
        let _ = app.emit(
            "vuln-progress",
            "No services with detected product/version to check. Try a Version Detection or Script Scan first.".to_string(),
        );
        return Ok(results);
    }

    for (i, (key, product, version)) in targets.into_iter().enumerate() {
        let _ = app.emit(
            "vuln-progress",
            format!("[{}/{}] Checking {} — {} {}", i + 1, total, key, product, version),
        );

        match lookup_vulns(&product, &version).await {
            Ok(vulns) if !vulns.is_empty() => {
                let _ = app.emit(
                    "vuln-progress",
                    format!("  -> found {} CVE(s) for {}", vulns.len(), key),
                );
                results.insert(key, vulns);
            }
            Ok(_) => {}
            Err(e) => {
                let _ = app.emit("vuln-progress", format!("  -> lookup failed for {key}: {e}"));
            }
        }

        tokio::time::sleep(std::time::Duration::from_millis(6500)).await;
    }

    let _ = app.emit("vuln-progress", "Vulnerability check complete.".to_string());
    Ok(results)
}

/// Runs a local searchsploit lookup for a given product/version string.
/// Fast and offline — no rate limiting needed like NVD.
#[tauri::command]
async fn search_exploit_db(query: String) -> Result<Vec<ExploitInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || search_exploits(&query))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}

/// Ettercap host discovery (Step 1): scans `iface` for `duration_secs` seconds,
/// no MITM performed, returns the discovered host list.
#[tauri::command]
async fn ettercap_discover_hosts(
    app: tauri::AppHandle,
    iface: String,
    duration_secs: u64,
) -> Result<Vec<HostEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || discover_hosts(&app, &iface, duration_secs))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}

/// Ettercap MITM (Step 2): starts an ARP MITM session against the selected
/// target IPs. Refuses to start a second session while one is already running,
/// unless the previously stored process has already exited on its own.
#[tauri::command]
async fn ettercap_start_mitm(
    app: tauri::AppHandle,
    state: tauri::State<'_, MitmState>,
    iface: String,
    targets: Vec<String>,
    gateway: Option<String>,
) -> Result<(), String> {
    {
        let mut guard = state.0.lock().unwrap();
        if let Some(child) = guard.as_mut() {
            match child.try_wait() {
                // Process already exited on its own (crash, bad args, killed
                // externally, etc.) — the stored handle is stale, clear it
                // and let the new session start.
                Ok(Some(_)) => {
                    *guard = None;
                }
                // Still genuinely running — refuse.
                Ok(None) => {
                    return Err("A MITM session is already running. Stop it first.".to_string());
                }
                // Couldn't determine status — treat as stale rather than
                // permanently locking the user out.
                Err(_) => {
                    *guard = None;
                }
            }
        }
    }

    let child = tauri::async_runtime::spawn_blocking(move || {
        start_mitm(&app, &iface, &targets, gateway.as_deref())
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))??;

    let mut guard = state.0.lock().unwrap();
    *guard = Some(child);
    Ok(())
}

/// Stops the currently running MITM session, if any.
#[tauri::command]
fn ettercap_stop_mitm(state: tauri::State<'_, MitmState>) -> Result<(), String> {
    let mut guard = state.0.lock().unwrap();
    if let Some(mut child) = guard.take() {
        stop_mitm(&mut child)
    } else {
        Err("No MITM session is running.".to_string())
    }
}

/// Runs a nuclei scan against `target`, optionally scoped by comma-separated
/// template tags. Streams findings live via "nuclei-finding" events and
/// returns the full collected list once the scan completes.
#[tauri::command]
async fn nuclei_scan(
    app: tauri::AppHandle,
    target: String,
    tags: Option<String>,
) -> Result<Vec<NucleiFinding>, String> {
    tauri::async_runtime::spawn_blocking(move || run_nuclei(&app, &target, tags.as_deref()))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(MitmState::default())
        .invoke_handler(tauri::generate_handler![
            greet,
            scan_network,
            check_vulnerabilities,
            search_exploit_db,
            ettercap_discover_hosts,
            ettercap_start_mitm,
            ettercap_stop_mitm,
            nuclei_scan
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}