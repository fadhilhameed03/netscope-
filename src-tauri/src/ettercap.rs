use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct HostEntry {
    pub ip: String,
    pub mac: String,
    pub description: String,
}

#[derive(Serialize, Clone)]
pub struct EttercapProgress {
    pub message: String,
}

/// Runs `ettercap` in text mode as a host-only scan (no MITM) for up to `duration_secs`,
/// then sends SIGINT so it flushes the discovered host list to a temp file,
/// and parses that file into HostEntry records.
///
/// Requires the ettercap binary to have raw-socket capabilities set:
///   sudo setcap cap_net_raw,cap_net_admin+eip $(which ettercap)
/// (pkexec was found unreliable for granting CAP_NET_RAW on some setups.)
pub fn discover_hosts(
    app: &AppHandle,
    iface: &str,
    duration_secs: u64,
) -> Result<Vec<HostEntry>, String> {
    let hosts_path = format!("/tmp/netscope_ettercap_{}.hosts", uuid::Uuid::new_v4());

    let mut cmd = Command::new("ettercap");
    cmd.arg("-T")
        .arg("-q")
        .arg("-i")
        .arg(iface)
        .arg("-o") // only-mitm off: scan only, don't attack
        .arg("-k")
        .arg(&hosts_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let _ = app.emit(
        "ettercap-progress",
        EttercapProgress {
            message: format!("Launching: ettercap -T -q -i {iface} -o -k {hosts_path}"),
        },
    );

    let mut child = cmd.spawn().map_err(|e| {
        format!(
            "Failed to launch ettercap: {e}. If this is a permissions error, run: \
             sudo setcap cap_net_raw,cap_net_admin+eip $(which ettercap)"
        )
    })?;
    let pid = child.id();

    if let Some(stdout) = child.stdout.take() {
        let app_clone = app.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().flatten() {
                if line.trim().is_empty() {
                    continue;
                }
                let _ = app_clone.emit("ettercap-progress", EttercapProgress { message: line });
            }
        });
    }

    let stderr_buf = Arc::new(Mutex::new(String::new()));
    if let Some(stderr) = child.stderr.take() {
        let app_clone = app.clone();
        let buf = Arc::clone(&stderr_buf);
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().flatten() {
                if line.trim().is_empty() {
                    continue;
                }
                buf.lock().unwrap().push_str(&line);
                buf.lock().unwrap().push('\n');
                let _ = app_clone.emit(
                    "ettercap-progress",
                    EttercapProgress { message: format!("[stderr] {line}") },
                );
            }
        });
    }

    let start = Instant::now();
    let mut exited_early = false;
    while start.elapsed() < Duration::from_secs(duration_secs) {
        match child.try_wait() {
            Ok(Some(_)) => {
                exited_early = true;
                break;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(300)),
            Err(e) => return Err(format!("Error polling ettercap process: {e}")),
        }
    }

    if !exited_early {
        let _ = Command::new("kill").arg("-INT").arg(pid.to_string()).status();
        std::thread::sleep(Duration::from_millis(800));
        if child.try_wait().ok().flatten().is_none() {
            let _ = child.kill();
        }
    }
    let _ = child.wait();

    let stderr_text = stderr_buf.lock().unwrap().clone();

    if exited_early {
        let _ = fs::remove_file(&hosts_path);
        let hint = if stderr_text.contains("Operation not permitted")
            || stderr_text.contains("CAP_NET_RAW")
        {
            " Fix: sudo setcap cap_net_raw,cap_net_admin+eip $(which ettercap)".to_string()
        } else if stderr_text.trim().is_empty() {
            " No stderr captured — check the interface name.".to_string()
        } else {
            format!(" stderr:\n{stderr_text}")
        };
        return Err(format!(
            "ettercap exited early (before the scan window finished).{hint}"
        ));
    }

    let _ = app.emit(
        "ettercap-progress",
        EttercapProgress { message: "Scan finished, parsing host list...".into() },
    );

    let content = fs::read_to_string(&hosts_path).map_err(|e| {
        format!(
            "Couldn't read ettercap host file: {e}.{}",
            if stderr_text.trim().is_empty() {
                String::new()
            } else {
                format!(" stderr:\n{stderr_text}")
            }
        )
    })?;
    let _ = fs::remove_file(&hosts_path);

    Ok(parse_host_file(&content))
}

fn parse_host_file(content: &str) -> Vec<HostEntry> {
    let mut hosts = Vec::new();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.split_whitespace();
        let ip = parts.next().unwrap_or("").to_string();
        let mac = parts.next().unwrap_or("").to_string();
        let description = parts.collect::<Vec<_>>().join(" ");
        if !ip.is_empty() {
            hosts.push(HostEntry { ip, mac, description });
        }
    }
    hosts
}

pub fn start_mitm(
    app: &AppHandle,
    iface: &str,
    targets: &[String],
    gateway: Option<&str>,
) -> Result<Child, String> {
    if targets.is_empty() {
        return Err("Select at least one target host before starting MITM.".to_string());
    }

    // This ettercap build is compiled WITH_IPV6, so TARGET format is
    // MAC/IP/IPv6/PORT — 4 fields, 3 slashes. An all-empty target (match
    // anything) is therefore "///", not the old pre-IPv6 "//".
    let target_spec = format!("/{}//", targets.join(","));
    let gateway_spec = match gateway {
        Some(gw) if !gw.trim().is_empty() => format!("/{}//", gw.trim()),
        _ => "///".to_string(),
    };

    let mut cmd = Command::new("ettercap");
    cmd.arg("-T")
        .arg("-q")
        .arg("-i")
        .arg(iface)
        .arg("-M")
        .arg("arp:remote")
        .arg(&target_spec)
        .arg(&gateway_spec)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let _ = app.emit(
        "ettercap-mitm-progress",
        EttercapProgress {
            message: format!(
                "Launching: ettercap -T -q -i {iface} -M arp:remote {target_spec} {gateway_spec}"
            ),
        },
    );

    let mut child = cmd.spawn().map_err(|e| {
        format!(
            "Failed to launch ettercap MITM: {e}. If this is a permissions error, run: \
             sudo setcap cap_net_raw,cap_net_admin+eip $(which ettercap)"
        )
    })?;

    if let Some(stdout) = child.stdout.take() {
        let app_clone = app.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().flatten() {
                if line.trim().is_empty() {
                    continue;
                }
                let _ = app_clone.emit("ettercap-mitm-progress", EttercapProgress { message: line });
            }
            let _ = app_clone.emit(
                "ettercap-mitm-progress",
                EttercapProgress { message: "[session ended]".into() },
            );
        });
    }

    if let Some(stderr) = child.stderr.take() {
        let app_clone = app.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().flatten() {
                if line.trim().is_empty() {
                    continue;
                }
                let _ = app_clone.emit(
                    "ettercap-mitm-progress",
                    EttercapProgress { message: format!("[stderr] {line}") },
                );
            }
        });
    }
    Ok(child)
}

/// Stops a running MITM session started by `start_mitm`: sends SIGINT so
/// ettercap can restore ARP tables cleanly, then force-kills if it hasn't
/// exited shortly after.
pub fn stop_mitm(child: &mut Child) -> Result<(), String> {
    let pid = child.id();
    let _ = Command::new("kill").arg("-INT").arg(pid.to_string()).status();
    std::thread::sleep(Duration::from_millis(800));
    if child.try_wait().ok().flatten().is_none() {
        let _ = child.kill();
    }
    let _ = child.wait();
    Ok(())
}