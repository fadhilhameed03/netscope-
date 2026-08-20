use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct NucleiFinding {
    pub template_id: String,
    pub name: String,
    pub severity: String,
    pub host: String,
    pub matched_at: String,
    pub description: String,
    pub tags: Vec<String>,
    pub reference: Vec<String>,
    pub cve_id: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct NucleiProgress {
    pub message: String,
}

#[derive(Deserialize)]
struct RawResult {
    #[serde(rename = "template-id")]
    template_id: String,
    info: RawInfo,
    host: Option<String>,
    #[serde(rename = "matched-at")]
    matched_at: Option<String>,
}

#[derive(Deserialize)]
struct RawInfo {
    name: String,
    severity: String,
    description: Option<String>,
    tags: Option<Vec<String>>,
    reference: Option<Value>,
    classification: Option<RawClassification>,
}

#[derive(Deserialize)]
struct RawClassification {
    #[serde(rename = "cve-id")]
    cve_id: Option<Vec<String>>,
}

/// Nuclei's `reference` field is inconsistent across templates — sometimes a
/// single string, sometimes an array. Normalize both into Vec<String>.
fn normalize_reference(v: Option<Value>) -> Vec<String> {
    match v {
        Some(Value::String(s)) => vec![s],
        Some(Value::Array(arr)) => arr
            .into_iter()
            .filter_map(|item| item.as_str().map(|s| s.to_string()))
            .collect(),
        _ => vec![],
    }
}

fn parse_line(line: &str) -> Option<NucleiFinding> {
    let raw: RawResult = serde_json::from_str(line).ok()?;
    let cve_id = raw
        .info
        .classification
        .and_then(|c| c.cve_id)
        .and_then(|ids| ids.into_iter().next());

    Some(NucleiFinding {
        template_id: raw.template_id,
        name: raw.info.name,
        severity: raw.info.severity,
        host: raw.host.unwrap_or_default(),
        matched_at: raw.matched_at.unwrap_or_default(),
        description: raw.info.description.unwrap_or_default(),
        tags: raw.info.tags.unwrap_or_default(),
        reference: normalize_reference(raw.info.reference),
        cve_id,
    })
}

/// Runs `nuclei -u <target> -jsonl` and streams results as they're found.
///
/// Each matched finding is parsed and emitted individually via the
/// "nuclei-finding" event as soon as it's discovered (nuclei can take a
/// while against a large template set, so the frontend table fills in
/// live rather than waiting for the whole scan to finish). Any non-JSON
/// stdout/stderr lines (nuclei's own status output) are emitted as
/// "nuclei-progress" text. The full collected list is also returned once
/// the process exits, for callers that just want the final result.
///
/// `tags`: comma-separated nuclei template tags (e.g. "cves,exposures").
/// None or empty runs nuclei's default template set.
pub fn run_nuclei(
    app: &AppHandle,
    target: &str,
    tags: Option<&str>,
) -> Result<Vec<NucleiFinding>, String> {
    let mut cmd = Command::new("nuclei");
    cmd.arg("-u").arg(target).arg("-jsonl").arg("-silent");

    let clean_tags = tags.map(|t| t.trim()).filter(|t| !t.is_empty());
    if let Some(t) = clean_tags {
        cmd.arg("-tags").arg(t);
    }

    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let _ = app.emit(
        "nuclei-progress",
        NucleiProgress {
            message: format!(
                "Launching: nuclei -u {target} -jsonl -silent{}",
                clean_tags.map(|t| format!(" -tags {t}")).unwrap_or_default()
            ),
        },
    );

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to launch nuclei: {e}. Is it installed and on PATH?"))?;

    let findings: Arc<Mutex<Vec<NucleiFinding>>> = Arc::new(Mutex::new(Vec::new()));

    let stdout_handle = child.stdout.take().map(|stdout| {
        let app_clone = app.clone();
        let findings_clone = Arc::clone(&findings);
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().flatten() {
                if line.trim().is_empty() {
                    continue;
                }
                match parse_line(&line) {
                    Some(finding) => {
                        let _ = app_clone.emit("nuclei-finding", finding.clone());
                        findings_clone.lock().unwrap().push(finding);
                    }
                    None => {
                        let _ = app_clone.emit("nuclei-progress", NucleiProgress { message: line });
                    }
                }
            }
        })
    });

    let stderr_buf = Arc::new(Mutex::new(String::new()));
    let stderr_handle = child.stderr.take().map(|stderr| {
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
                let _ = app_clone.emit("nuclei-progress", NucleiProgress { message: line });
            }
        })
    });

    let status = child
        .wait()
        .map_err(|e| format!("nuclei process error: {e}"))?;

    if let Some(h) = stdout_handle {
        let _ = h.join();
    }
    if let Some(h) = stderr_handle {
        let _ = h.join();
    }

    if !status.success() {
        let err_text = stderr_buf.lock().unwrap().clone();
        let hint = if err_text.trim().is_empty() {
            "no stderr captured — check the target URL/host.".to_string()
        } else {
            format!("stderr:\n{err_text}")
        };
        return Err(format!("nuclei exited with an error: {hint}"));
    }

    let _ = app.emit(
        "nuclei-progress",
        NucleiProgress { message: "Scan finished.".into() },
    );

    let result = findings.lock().unwrap().clone();
    Ok(result)
}