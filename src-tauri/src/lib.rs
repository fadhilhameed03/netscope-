mod scan;
mod vuln;
mod exploit;
mod ettercap;
mod nuclei;
#[cfg(target_os = "linux")]
mod native_browser;
use scan::{parse_nmap_xml, run_nmap, HostInfo};
use vuln::{lookup_vulns, VulnInfo};
use exploit::{search_exploits, ExploitInfo};
use ettercap::{discover_hosts, start_mitm, stop_mitm, HostEntry};
use nuclei::{run_nuclei, NucleiFinding};
use std::collections::HashMap;
use std::process::Child;
use std::sync::Mutex;
use tauri::Emitter;
use reqwest;

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct PageInfo {
    pub url: String,
    pub final_url: String,
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub title: Option<String>,
    pub content_type: Option<String>,
    pub content_length: Option<u64>,
    pub server: Option<String>,
}

#[tauri::command]
async fn fetch_page_info(url: String) -> Result<PageInfo, String> {
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36")
        .redirect(reqwest::redirect::Policy::limited(10))
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;

    let final_url = resp.url().to_string();
    let status = resp.status().as_u16();

    let headers: Vec<(String, String)> = resp
        .headers()
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("<binary>").to_string()))
        .collect();

    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    let content_length = resp
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok());

    let server = resp
        .headers()
        .get("server")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    let body = resp.text().await.unwrap_or_default();

    let title = {
        let lower = body.to_lowercase();
        let start = lower.find("<title>").map(|i| i + 7);
        let end = lower.find("</title>");
        match (start, end) {
            (Some(s), Some(e)) if s < e => Some(body[s..e].trim().to_string()),
            _ => None,
        }
    };

    Ok(PageInfo {
        url,
        final_url,
        status,
        headers,
        title,
        content_type,
        content_length,
        server,
    })
}

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
#[tauri::command]
async fn search_exploit_db(query: String) -> Result<Vec<ExploitInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || search_exploits(&query))
        .await
        .map_err(|e| format!("Task join error: {e}"))?
}

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
                Ok(Some(_)) => {
                    *guard = None;
                }
                Ok(None) => {
                    return Err("A MITM session is already running. Stop it first.".to_string());
                }
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

#[tauri::command]
fn ettercap_stop_mitm(state: tauri::State<'_, MitmState>) -> Result<(), String> {
    let mut guard = state.0.lock().unwrap();
    if let Some(mut child) = guard.take() {
        stop_mitm(&mut child)
    } else {
        Err("No MITM session is running.".to_string())
    }
}

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

// ── Native embedded browser commands ──────────────────────────────────
// Real implementations on Linux (see native_browser.rs); harmless stub
// errors elsewhere so the frontend's invoke() surface stays the same
// across platforms without special-casing.

#[tauri::command]
async fn native_browser_navigate(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            native_browser::navigate(window, app, url, x, y, width, height)
        })
        .await
        .map_err(|e| format!("Task join error: {e}"))?
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (window, app, url, x, y, width, height);
        Err("Native embedded browser is only implemented for Linux.".to_string())
    }
}

#[tauri::command]
async fn native_browser_set_bounds(
    window: tauri::WebviewWindow,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            native_browser::set_bounds(window, x, y, width, height)
        })
        .await
        .map_err(|e| format!("Task join error: {e}"))?
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (window, x, y, width, height);
        Err("Native embedded browser is only implemented for Linux.".to_string())
    }
}

#[tauri::command]
async fn native_browser_set_visible(window: tauri::WebviewWindow, visible: bool) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        tauri::async_runtime::spawn_blocking(move || native_browser::set_visible(window, visible))
            .await
            .map_err(|e| format!("Task join error: {e}"))?
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (window, visible);
        Err("Native embedded browser is only implemented for Linux.".to_string())
    }
}

#[tauri::command]
async fn native_browser_go_back(window: tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        tauri::async_runtime::spawn_blocking(move || native_browser::go_back(window))
            .await
            .map_err(|e| format!("Task join error: {e}"))?
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = window;
        Err("Native embedded browser is only implemented for Linux.".to_string())
    }
}

#[tauri::command]
async fn native_browser_go_forward(window: tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        tauri::async_runtime::spawn_blocking(move || native_browser::go_forward(window))
            .await
            .map_err(|e| format!("Task join error: {e}"))?
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = window;
        Err("Native embedded browser is only implemented for Linux.".to_string())
    }
}

#[tauri::command]
async fn native_browser_refresh(window: tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        tauri::async_runtime::spawn_blocking(move || native_browser::refresh(window))
            .await
            .map_err(|e| format!("Task join error: {e}"))?
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = window;
        Err("Native embedded browser is only implemented for Linux.".to_string())
    }
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
            nuclei_scan,
            fetch_page_info,
            native_browser_navigate,
            native_browser_set_bounds,
            native_browser_set_visible,
            native_browser_go_back,
            native_browser_go_forward,
            native_browser_refresh
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}