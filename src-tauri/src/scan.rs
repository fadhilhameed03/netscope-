use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use roxmltree::{Document, ParsingOptions};
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PortInfo {
    pub port: u16,
    pub protocol: String,
    pub state: String,
    pub service: String,
    pub product: String,
    pub version: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct HostInfo {
    pub ip: String,
    pub hostname: String,
    pub state: String,
    pub os: String,
    pub mac: String,
    pub vendor: String,
    pub ports: Vec<PortInfo>,
}

#[derive(Serialize, Clone)]
pub struct ScanProgress {
    pub message: String,
    pub percent: Option<f32>,
}

pub fn profile_args(profile: &str) -> Vec<&'static str> {
    match profile {
        "quick"       => vec!["-T4", "-F"],
        "intense"     => vec!["-T4", "-A"],
        "stealth_syn" => vec!["-sS", "-T2"],
        "version"     => vec!["-sV"],
        "os_detect"   => vec!["-O"],
        "script_scan" => vec!["-sC", "-sV"],
        "ping_sweep"  => vec!["-sn"],
        "full_port"   => vec!["-p-", "-T4"],
        _             => vec!["-T4", "-F"],
    }
}

pub fn needs_root(profile: &str) -> bool {
    matches!(profile, "stealth_syn" | "os_detect" | "intense" | "ping_sweep")
}

/// Extra check for when the user has hand-edited the command field:
/// certain flags need raw sockets regardless of which "profile" was originally picked.
fn args_need_root(args: &[String]) -> bool {
    args.iter().any(|a| {
        a == "-sS" || a == "-O" || a == "-sU" || a == "-A" || a == "-sn" || a.starts_with("-b")
    })
}

fn extract_percent(line: &str) -> Option<f32> {
    let idx = line.find('%')?;
    let start = line[..idx].rfind(|c: char| c == ' ' || c == ':')? + 1;
    line[start..idx].trim().parse::<f32>().ok()
}

/// `custom_args`: if Some and non-empty, overrides the profile's default flags
/// (this is what powers the editable Zenmap-style "Command:" field).
pub fn run_nmap(
    app: &AppHandle,
    target: &str,
    profile: &str,
    custom_args: Option<&str>,
) -> Result<String, String> {
    let args: Vec<String> = match custom_args {
        Some(s) if !s.trim().is_empty() => {
            s.split_whitespace().map(|x| x.to_string()).collect()
        }
        _ => profile_args(profile).into_iter().map(|s| s.to_string()).collect(),
    };

    let use_root = needs_root(profile) || args_need_root(&args);
    let xml_path = format!("/tmp/netscope_scan_{}.xml", uuid::Uuid::new_v4());

    let mut cmd = if use_root {
        let mut c = Command::new("pkexec");
        c.arg("nmap");
        c
    } else {
        Command::new("nmap")
    };

    cmd.args(&args)
        .arg("-v")
        .arg("--stats-every")
        .arg("1s")
        .arg("-oX")
        .arg(&xml_path)
        .arg(target)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let _ = app.emit("scan-progress", ScanProgress {
        message: format!("Launching: nmap {} {}", args.join(" "), target),
        percent: None,
    });

    let mut child = cmd.spawn().map_err(|e| format!("Failed to launch nmap: {e}"))?;

    if let Some(stdout) = child.stdout.take() {
        let app_clone = app.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().flatten() {
                if line.trim().is_empty() {
                    continue;
                }
                let percent = extract_percent(&line);
                let _ = app_clone.emit("scan-progress", ScanProgress { message: line, percent });
            }
        });
    }

    let stderr_buf = Arc::new(Mutex::new(String::new()));
    let stderr_handle = child.stderr.take().map(|stderr| {
        let buf = Arc::clone(&stderr_buf);
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().flatten() {
                buf.lock().unwrap().push_str(&line);
                buf.lock().unwrap().push('\n');
            }
        })
    });

    let status = child.wait().map_err(|e| format!("nmap process error: {e}"))?;
    if let Some(h) = stderr_handle {
        let _ = h.join();
    }

    if !status.success() {
        let err_text = stderr_buf.lock().unwrap().clone();
        let _ = fs::remove_file(&xml_path);
        return Err(format!("nmap failed: {err_text}"));
    }

    let _ = app.emit("scan-progress", ScanProgress {
        message: "Scan finished, parsing results...".into(),
        percent: Some(100.0),
    });

    let xml = fs::read_to_string(&xml_path).map_err(|e| format!("Couldn't read scan output: {e}"))?;
    let _ = fs::remove_file(&xml_path);
    Ok(xml)
}

pub fn parse_nmap_xml(xml: &str) -> Result<Vec<HostInfo>, String> {
    let opts = ParsingOptions { allow_dtd: true, ..Default::default() };
    let doc = Document::parse_with_options(xml, opts).map_err(|e| format!("XML parse error: {e}"))?;
    let mut hosts = Vec::new();

    for host_node in doc.descendants().filter(|n| n.has_tag_name("host")) {
        let state = host_node
            .children()
            .find(|n| n.has_tag_name("status"))
            .and_then(|n| n.attribute("state"))
            .unwrap_or("unknown")
            .to_string();

        let mut ip = String::new();
        let mut mac = String::new();
        let mut vendor = String::new();
        for addr in host_node.children().filter(|n| n.has_tag_name("address")) {
            match addr.attribute("addrtype") {
                Some("ipv4") | Some("ipv6") => ip = addr.attribute("addr").unwrap_or("").to_string(),
                Some("mac") => {
                    mac = addr.attribute("addr").unwrap_or("").to_string();
                    vendor = addr.attribute("vendor").unwrap_or("").to_string();
                }
                _ => {}
            }
        }

        let hostname = host_node
            .children()
            .find(|n| n.has_tag_name("hostnames"))
            .and_then(|hn| hn.children().find(|n| n.has_tag_name("hostname")))
            .and_then(|n| n.attribute("name"))
            .unwrap_or("")
            .to_string();

        let os = host_node
            .children()
            .find(|n| n.has_tag_name("os"))
            .and_then(|osn| osn.children().find(|n| n.has_tag_name("osmatch")))
            .and_then(|n| n.attribute("name"))
            .unwrap_or("Unknown")
            .to_string();

        let mut ports = Vec::new();
        if let Some(ports_node) = host_node.children().find(|n| n.has_tag_name("ports")) {
            for port_node in ports_node.children().filter(|n| n.has_tag_name("port")) {
                let port_num: u16 = port_node.attribute("portid").unwrap_or("0").parse().unwrap_or(0);
                let protocol = port_node.attribute("protocol").unwrap_or("").to_string();
                let port_state = port_node
                    .children()
                    .find(|n| n.has_tag_name("state"))
                    .and_then(|n| n.attribute("state"))
                    .unwrap_or("unknown")
                    .to_string();
                let service_node = port_node.children().find(|n| n.has_tag_name("service"));
                let service = service_node.and_then(|n| n.attribute("name")).unwrap_or("").to_string();
                let product = service_node.and_then(|n| n.attribute("product")).unwrap_or("").to_string();
                let version = service_node.and_then(|n| n.attribute("version")).unwrap_or("").to_string();
                ports.push(PortInfo { port: port_num, protocol, state: port_state, service, product, version });
            }
        }

        if !ip.is_empty() {
            hosts.push(HostInfo { ip, hostname, state, os, mac, vendor, ports });
        }
    }

    Ok(hosts)
}