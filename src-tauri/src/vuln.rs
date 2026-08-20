use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct VulnInfo {
    pub cve_id: String,
    pub severity: Option<f32>,
    pub summary: String,
}

#[derive(Deserialize)]
struct NvdResponse {
    vulnerabilities: Vec<NvdVulnWrapper>,
}

#[derive(Deserialize)]
struct NvdVulnWrapper {
    cve: NvdCve,
}

#[derive(Deserialize)]
struct NvdCve {
    id: String,
    descriptions: Vec<NvdDescription>,
    metrics: Option<NvdMetrics>,
}

#[derive(Deserialize)]
struct NvdDescription {
    lang: String,
    value: String,
}

#[derive(Deserialize)]
struct NvdMetrics {
    #[serde(rename = "cvssMetricV31")]
    cvss_v31: Option<Vec<NvdCvssMetric>>,
    #[serde(rename = "cvssMetricV30")]
    cvss_v30: Option<Vec<NvdCvssMetric>>,
    #[serde(rename = "cvssMetricV2")]
    cvss_v2: Option<Vec<NvdCvssMetric>>,
}

#[derive(Deserialize)]
struct NvdCvssMetric {
    #[serde(rename = "cvssData")]
    cvss_data: NvdCvssData,
}

#[derive(Deserialize)]
struct NvdCvssData {
    #[serde(rename = "baseScore")]
    base_score: f32,
}

/// Queries NVD for CVEs matching a product + version keyword search.
/// Returns up to 5 results. On any request/parse failure, returns an empty
/// list rather than an error, so one bad lookup doesn't kill the whole batch.
pub async fn lookup_vulns(product: &str, version: &str) -> Result<Vec<VulnInfo>, String> {
    if product.trim().is_empty() {
        return Ok(vec![]);
    }

    let query = if version.trim().is_empty() {
        product.to_string()
    } else {
        format!("{product} {version}")
    };

    let encoded_query = query
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' || c == '~' {
                c.to_string()
            } else if c == ' ' {
                "%20".to_string()
            } else {
                format!("%{:02X}", c as u32)
            }
        })
        .collect::<String>();

    let url = format!(
        "https://services.nvd.nist.gov/rest/json/cves/2.0?keywordSearch={}&resultsPerPage=5",
        encoded_query
    );

    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .header("User-Agent", "NetScope/0.1 (student cybersecurity project)")
        .send()
        .await;

    let resp = match resp {
        Ok(r) => r,
        Err(_) => return Ok(vec![]),
    };

    if !resp.status().is_success() {
        return Ok(vec![]);
    }

    let parsed: Result<NvdResponse, _> = resp.json().await;
    let parsed = match parsed {
        Ok(p) => p,
        Err(_) => return Ok(vec![]),
    };

    let results = parsed
        .vulnerabilities
        .into_iter()
        .map(|w| {
            let cve = w.cve;
            let summary = cve
                .descriptions
                .iter()
                .find(|d| d.lang == "en")
                .map(|d| d.value.clone())
                .unwrap_or_default();

            let severity = cve.metrics.as_ref().and_then(|m| {
                m.cvss_v31
                    .as_ref()
                    .or(m.cvss_v30.as_ref())
                    .or(m.cvss_v2.as_ref())
                    .and_then(|v| v.first())
                    .map(|metric| metric.cvss_data.base_score)
            });

            VulnInfo {
                cve_id: cve.id,
                severity,
                summary: truncate(&summary, 200),
            }
        })
        .collect();

    Ok(results)
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}...", &s[..max])
    }
}