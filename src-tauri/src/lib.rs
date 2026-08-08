mod scan;
use scan::{run_nmap, parse_nmap_xml, HostInfo};

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![greet, scan_network])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}