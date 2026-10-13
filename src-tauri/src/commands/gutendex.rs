//! 书库：通过 Gutendex（Project Gutenberg 的公开 JSON API）搜索公版书并下载。
//!
//! 为什么整条链路都在 Rust 而不是 webview 的 `fetch`：
//! - **下载必须走 Rust** —— `www.gutenberg.org` 不返回任何 CORS 头，
//!   浏览器会拦掉对它的 fetch。
//! - 搜索虽然可用 fetch（gutendex.com 返回 `access-control-allow-origin: *`），
//!   但既然下载已经在这边，两个请求共用一个带系统代理的 client、逻辑只写一份更省事。
//!
//! 代理：`reqwest` 的 `system-proxy` 特性会读 Windows 注册表的代理设置，
//! 所以「系统代理开着就用、关了就直连」，不需要在应用里做代理配置界面。
//!
//! 只接 Project Gutenberg —— 内容全部是公版书，仓库公开也没有版权风险。

use crate::commands::import::ImportedBook;
use crate::{lock_db, AppState};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;
use tauri::ipc::Channel;
use tauri::State;

const GUTENDEX_BASE: &str = "https://gutendex.com/books/";

/// 允许下载的主机白名单。只认 Project Gutenberg 自己的域名 ——
/// 这个功能存在的理由是「公版书」，不能变成一个任意 URL 下载器。
const ALLOWED_HOSTS: [&str; 2] = ["www.gutenberg.org", "gutenberg.org"];

const USER_AGENT: &str = concat!(
    "da-zi-ji/",
    env!("CARGO_PKG_VERSION"),
    " (+https://github.com/jackLin5999/typing-chicken)"
);

/// 两套共享 client：一套跟随系统代理，一套强制直连。
///
/// **为什么必须有两套**（实测数据，同一个 URL 各打三次）：
/// ```text
///   直连         3/3 成功，每次 ~3.5s，拿到完整 1,228,855 字节
///   走本机代理   0/3 成功，每次 ~45s，只拿到 448,291–560,083 字节就被掐断
/// ```
/// 也就是说「系统配了代理」完全不等于「代理好用」：配置还在注册表里，
/// 但代理已经把大文件下载截断了。只认系统代理的话，用户会看到每本书都下载失败。
///
/// 反过来也不能只直连 —— 有人（公司网络、白名单防火墙）**必须**走代理，
/// 直连根本不通。所以两套都留着，逐次尝试时轮流用。
fn http_client(use_system_proxy: bool) -> Result<&'static reqwest::Client, String> {
    static PROXIED: OnceLock<reqwest::Client> = OnceLock::new();
    static DIRECT: OnceLock<reqwest::Client> = OnceLock::new();

    let slot = if use_system_proxy { &PROXIED } else { &DIRECT };
    if let Some(client) = slot.get() {
        return Ok(client);
    }

    let mut builder = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(300))
        .redirect(gutenberg_only_redirects())
        .user_agent(USER_AGENT);

    if !use_system_proxy {
        builder = builder.no_proxy();
    }

    let client = builder
        .build()
        .map_err(|e| format!("NET_ERROR: 无法创建网络客户端（{}）", e))?;

    Ok(slot.get_or_init(|| client))
}

/// 把 reqwest 的错误摊平成中文可读信息，并保留稳定前缀供前端分支。
/// 前端 `importErrorMessage` 会把 `NET_TIMEOUT:` 这类前缀剥掉再展示。
fn net_error(e: reqwest::Error) -> String {
    if e.is_timeout() {
        "NET_TIMEOUT: 连接书库超时，请检查网络或代理设置".to_string()
    } else if e.is_connect() {
        "NET_CONNECT: 无法连接到书库服务器，请检查网络或代理设置".to_string()
    } else {
        format!("NET_ERROR: 请求失败（{}）", e)
    }
}

// ── Gutendex 原始响应（只声明用得到的字段 + serde default，防 API 变动炸解析）──

#[derive(Debug, Deserialize)]
struct GxAuthor {
    name: String,
}

#[derive(Debug, Deserialize)]
struct GxBook {
    id: u64,
    title: String,
    #[serde(default)]
    authors: Vec<GxAuthor>,
    #[serde(default)]
    languages: Vec<String>,
    #[serde(default)]
    download_count: u64,
    #[serde(default)]
    formats: HashMap<String, String>,
}

#[derive(Debug, Deserialize)]
struct GxPage {
    count: u64,
    #[serde(default)]
    next: Option<String>,
    #[serde(default)]
    results: Vec<GxBook>,
}

// ── 返回给前端的 DTO ──────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CatalogBook {
    pub id: u64,
    pub title: String,
    pub author: String,
    /// Gutendex 的封面图（`image/jpeg`）。webview 用 `<img>` 直接加载即可 ——
    /// `<img>` 不受 CORS 约束，不像 fetch。
    pub cover_url: Option<String>,
    /// 没有 EPUB 的书（如纯音频本）为 `None`，前端不显示下载按钮。
    pub epub_url: Option<String>,
    pub languages: Vec<String>,
    pub download_count: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CatalogPage {
    pub count: u64,
    pub page: u32,
    pub has_next: bool,
    pub results: Vec<CatalogBook>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub received: u64,
    /// 服务端没给 `Content-Length` 时为 `None` —— 前端显示不确定进度。
    pub total: Option<u64>,
}

impl From<GxBook> for CatalogBook {
    fn from(b: GxBook) -> Self {
        CatalogBook {
            id: b.id,
            title: b.title,
            author: b
                .authors
                .into_iter()
                .next()
                .map(|a| a.name)
                .unwrap_or_else(|| "Unknown Author".to_string()),
            cover_url: b.formats.get("image/jpeg").cloned(),
            epub_url: b.formats.get("application/epub+zip").cloned(),
            languages: b.languages,
            download_count: b.download_count,
        }
    }
}

fn project_page(page: GxPage, requested_page: u32) -> CatalogPage {
    CatalogPage {
        count: page.count,
        page: requested_page,
        has_next: page.next.is_some(),
        // 纯客户端过滤：Gutendex 的 `mime_type` 参数把 `+` 当空格处理，实测不可靠。
        results: page
            .results
            .into_iter()
            .map(CatalogBook::from)
            .filter(|b| b.epub_url.is_some())
            .collect(),
    }
}

// ── 命令 ──────────────────────────────────────────────────────────────────

/// 发一次搜索请求。搜索是交互式的，超时收得比下载短很多。
async fn request_search(
    url: &reqwest::Url,
    use_system_proxy: bool,
) -> Result<reqwest::Response, String> {
    http_client(use_system_proxy)?
        .get(url.clone())
        .timeout(std::time::Duration::from_secs(25))
        .send()
        .await
        .map_err(net_error)
}

/// 搜索书库。`language` 传 `"zh"` / `"en"` 等两字母 ISO 码，空串按中文处理。
#[tauri::command]
pub async fn search_gutendex(
    query: String,
    language: String,
    page: u32,
) -> Result<CatalogPage, String> {
    let page = page.max(1);

    let mut url = reqwest::Url::parse(GUTENDEX_BASE)
        .map_err(|e| format!("NET_ERROR: 书库地址无效（{}）", e))?;
    {
        let mut pairs = url.query_pairs_mut();
        pairs.append_pair(
            "languages",
            if language.is_empty() { "zh" } else { &language },
        );
        let trimmed = query.trim();
        if !trimmed.is_empty() {
            pairs.append_pair("search", trimmed);
        }
        pairs.append_pair("page", &page.to_string());
    }

    // 先走系统代理（尊重用户配置），不通再直连 —— 与下载同样的取舍。
    let response = match request_search(&url, true).await {
        Ok(response) => response,
        Err(first) => request_search(&url, false).await.map_err(|_| first)?,
    };

    if !response.status().is_success() {
        return Err(format!(
            "NET_STATUS: 书库返回 {}，请稍后重试",
            response.status().as_u16()
        ));
    }

    let body: GxPage = response.json().await.map_err(net_error)?;
    Ok(project_page(body, page))
}

/// 校验下载地址 —— 只允许 Project Gutenberg 的 https EPUB 直链。
fn validate_epub_url(raw: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(raw)
        .map_err(|_| "INVALID_URL: 下载地址无效".to_string())?;

    if url.scheme() != "https" {
        return Err("INVALID_URL: 只支持 https 下载".to_string());
    }
    match url.host_str() {
        Some(host) if ALLOWED_HOSTS.contains(&host) => {}
        _ => return Err("INVALID_URL: 只能从 Project Gutenberg 下载".to_string()),
    }
    // Gutenberg 的 EPUB 直链有五种以上写法，别只认结尾的 `.epub`：
    //   /cache/epub/24264/pg24264.epub
    //   /ebooks/23962.epub3.images   ← Gutendex 实际返回的就是这个
    //   /ebooks/23962.epub3.noimages
    //   /ebooks/23962.epub.images
    //   /ebooks/23962.epub.noimages
    // 所以判据是「路径里含 .epub」，而不是「以 .epub 结尾」。
    if !url.path().to_ascii_lowercase().contains(".epub") {
        return Err("INVALID_URL: 只支持 EPUB 格式".to_string());
    }

    Ok(url)
}

/// 只跟随指向 Project Gutenberg 自己的重定向。
///
/// 上面校验的是**初始** URL，但 `/ebooks/23962.epub3.images` 实际会 302 到
/// `/cache/epub/23962/pg23962-images-3.epub`。默认策略会跟随到任何主机，
/// 那样「只能从 Gutenberg 下载」就只是一句空话了。
fn gutenberg_only_redirects() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= 5 {
            return attempt.error("too many redirects");
        }
        match attempt.url().host_str() {
            Some(host) if ALLOWED_HOSTS.contains(&host) => attempt.follow(),
            _ => attempt.error("redirect left gutenberg.org"),
        }
    })
}

/// 下载一本公版书并直接导入书架。
///
/// 顺序很关键：**所有网络 IO 都在获取 DB 锁之前完成**。
/// `import_from_path` 是同步的且内部持锁，绝不能在 `.await` 期间调用它，
/// 否则 `MutexGuard` 跨 await 会让这个 future 变成非 `Send`。
#[tauri::command]
pub async fn download_and_import_book(
    state: State<'_, AppState>,
    gutenberg_id: u64,
    url: String,
    on_progress: Channel<DownloadProgress>,
    convert_to_simplified: bool,
) -> Result<ImportedBook, String> {
    let url = validate_epub_url(&url)?;

    // 暂存目录：<data_dir>/downloads。用块作用域把锁的持有范围压到最小 ——
    // 块一结束 guard 就释放，后面的 await 才安全。
    let staging_dir = {
        let db = lock_db(&state.db);
        let data_dir = db
            .books_dir()
            .parent()
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."));
        data_dir.join("downloads")
    };
    std::fs::create_dir_all(&staging_dir)
        .map_err(|e| format!("DOWNLOAD: 无法创建下载目录（{}）", e))?;

    // uuid 后缀：同一本书并发下载两次不会互相覆盖
    let staging = staging_dir.join(format!(
        "{}-{}.epub",
        gutenberg_id,
        uuid::Uuid::new_v4()
    ));

    let result = download_to_file(&url, &staging, |p| {
        let _ = on_progress.send(p);
    })
    .await;

    if let Err(e) = result {
        let _ = std::fs::remove_file(&staging);
        return Err(e);
    }

    // import_from_path 会把文件复制进永久的书本目录，所以这里删掉暂存件不会孤儿。
    let imported = super::import::import_from_path(
        &state,
        &staging.to_string_lossy(),
        Some(&gutenberg_id.to_string()),
        convert_to_simplified,
    );
    let _ = std::fs::remove_file(&staging);
    imported
}

/// 下载失败的分类结果：给用户看的信息 + 值不值得重试。
struct DownloadFailure {
    message: String,
    retryable: bool,
}

impl DownloadFailure {
    fn fatal(message: impl Into<String>) -> Self {
        Self { message: message.into(), retryable: false }
    }
}

/// 一本几 MB 的书要穿过用户的代理，中途被掐断是**常态**而不是意外。
///
/// 实测同一个 URL 连打三次：91,699 字节（截断）、直接连接失败、1,228,855 字节（完整）
/// —— 单次成功率大概只有 1/3。重试 3 次仍有约 30% 的概率整个失败，所以给到 5 次
/// （成功率约 87%）。再高就得不偿失了：用户看着一个卡住的进度条比看一句报错更难受。
const DOWNLOAD_ATTEMPTS: u32 = 5;

/// 边下边写；中断后**从断点续传**，而不是整本重来。
///
/// Gutenberg 明确返回 `accept-ranges: bytes`，所以带 `Range` 头续传可行。
/// 这对本项目意义很大：实测单次请求成功率只有 1/3 左右，
/// 若每次失败都从 0 重来，一本 1.2MB 的书几乎下不完；
/// 续传让**每次尝试都有进展**，几轮之后自然凑齐全部字节。
async fn download_to_file<F: FnMut(DownloadProgress)>(
    url: &reqwest::Url,
    destination: &std::path::Path,
    mut on_progress: F,
) -> Result<(), String> {
    let mut last_message = String::new();

    for attempt in 1..=DOWNLOAD_ATTEMPTS {
        // 磁盘上已经攒了多少（上一轮断在这里）
        let resume_from = std::fs::metadata(destination)
            .map(|m| m.len())
            .unwrap_or(0);

        // 奇数轮先试直连，偶数轮走系统代理 —— 两边都试到，谁通用谁。
        // 配合断点续传，即使中途换路线（直连下了一半、代理接着下）也不会白费。
        let use_system_proxy = attempt % 2 == 0;

        match download_attempt(url, destination, resume_from, use_system_proxy, &mut on_progress)
            .await
        {
            Ok(()) => return Ok(()),
            Err(failure) => {
                if !failure.retryable || attempt == DOWNLOAD_ATTEMPTS {
                    return Err(failure.message);
                }
                last_message = failure.message;
                // 退避一下再试 —— 立刻重连常常撞上同样的抖动
                tokio::time::sleep(std::time::Duration::from_millis(
                    600 * u64::from(attempt),
                ))
                .await;
            }
        }
    }

    Err(last_message)
}

/// 一次尝试；`resume_from > 0` 时带 `Range` 头从断点续写。
///
/// 按「整数百分比」节流上报进度 —— 15MB 的文件如果每个 chunk 都发一条 IPC，
/// 会打出上千条消息。
async fn download_attempt<F: FnMut(DownloadProgress)>(
    url: &reqwest::Url,
    destination: &std::path::Path,
    resume_from: u64,
    use_system_proxy: bool,
    on_progress: &mut F,
) -> Result<(), DownloadFailure> {
    let mut request = http_client(use_system_proxy)
        .map_err(DownloadFailure::fatal)?
        .get(url.clone());
    if resume_from > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={}-", resume_from));
    }

    let mut response = request.send().await.map_err(|e| DownloadFailure {
        message: net_error(e),
        // 连不上/超时值得重试；其他（DNS、TLS 证书等）未必，但重试也无害
        retryable: true,
    })?;

    if !response.status().is_success() {
        let status = response.status();
        return Err(DownloadFailure {
            message: format!("NET_STATUS: 下载失败，服务器返回 {}", status.as_u16()),
            // 4xx 是客户端问题，重试没意义；5xx 值得再试
            retryable: status.is_server_error(),
        });
    }

    // 只有服务端真的认了 Range（206）才能接着写。它若回 200 全量，
    // 说明忽略了 Range —— 必须从头覆盖，否则会把旧字节接在新内容前面。
    let resuming = resume_from > 0 && response.status() == reqwest::StatusCode::PARTIAL_CONTENT;

    // 206 的 Content-Length 是**剩余**长度，加上已下载的才是总长
    let total = response
        .content_length()
        .map(|len| if resuming { resume_from + len } else { len });

    let mut received: u64 = if resuming { resume_from } else { 0 };
    let mut file = if resuming {
        std::fs::OpenOptions::new().append(true).open(destination)
    } else {
        std::fs::File::create(destination)
    }
    .map_err(|e| DownloadFailure::fatal(format!("DOWNLOAD: 无法写入下载目录（{}）", e)))?;

    let mut last_percent: Option<u64> = None;

    // `chunk()` 不受 feature 门控，不需要开 `stream` 特性或引 futures-util。
    loop {
        let chunk = match response.chunk().await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            // 中途断流会走到这里，这是最典型的可重试失败。
            // 已写入的字节留在磁盘上，下一轮从断点接着下。
            Err(e) => {
                return Err(DownloadFailure {
                    message: net_error(e),
                    retryable: true,
                })
            }
        };

        file.write_all(&chunk).map_err(|e| {
            DownloadFailure::fatal(format!("DOWNLOAD: 写入失败（{}）", e))
        })?;
        received += chunk.len() as u64;

        if let Some(total) = total.filter(|t| *t > 0) {
            let percent = received.saturating_mul(100) / total;
            if last_percent != Some(percent) {
                last_percent = Some(percent);
                on_progress(DownloadProgress {
                    received,
                    total: Some(total),
                });
            }
        }
    }

    // File 不带缓冲，write_all 已直接落盘；这里只需把错误路径上的句柄关掉即可
    drop(file);

    // 服务端报了长度就得对上 —— 否则会拿着一个截断的 zip 去解析，
    // 报出来的是「EPUB 解析失败」这种驴唇不对马嘴的错误。
    if let Some(expected) = total.filter(|t| *t > 0) {
        if received != expected {
            return Err(DownloadFailure {
                message: format!(
                    "NET_ERROR: 下载不完整（{} / {} 字节），请重试",
                    received, expected
                ),
                retryable: true,
            });
        }
    }

    // 收尾：确保前端拿到 100%（上面按百分比节流可能漏掉最后一格）
    on_progress(DownloadProgress {
        received,
        total: total.or(Some(received)),
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 真实抓的一页（截取前 2 条），用来锁住反序列化与字段提取，
    /// 不联网。id 20968 是纯音频本 —— 没有 `application/epub+zip` 键。
    const SAMPLE_PAGE: &str = r#"{
      "count": 444,
      "next": "https://gutendex.com/books/?languages=zh&page=2",
      "previous": null,
      "results": [
        {
          "id": 20968,
          "title": "Three Hundred Tang Poems, Volume 1",
          "authors": [{"name": "Various", "birth_year": null, "death_year": null}],
          "languages": ["zh"],
          "download_count": 11915,
          "formats": {
            "text/html": "https://www.gutenberg.org/ebooks/20968.html.images",
            "image/jpeg": "https://www.gutenberg.org/cache/epub/20968/pg20968.cover.medium.jpg",
            "audio/mpeg": "https://www.gutenberg.org/files/20968/mp3/20968-01.mp3"
          }
        },
        {
          "id": 24264,
          "title": "紅樓夢",
          "authors": [{"name": "Cao, Xueqin", "birth_year": 1717, "death_year": 1763}],
          "languages": ["zh"],
          "download_count": 9312,
          "formats": {
            "text/plain; charset=utf-8": "https://www.gutenberg.org/files/24264/24264-0.txt",
            "application/epub+zip": "https://www.gutenberg.org/cache/epub/24264/pg24264.epub",
            "image/jpeg": "https://www.gutenberg.org/cache/epub/24264/pg24264.cover.medium.jpg"
          }
        }
      ]
    }"#;

    #[test]
    fn parses_a_real_gutendex_page() {
        let raw: GxPage = serde_json::from_str(SAMPLE_PAGE).expect("sample page must parse");

        assert_eq!(raw.count, 444);
        assert_eq!(raw.results.len(), 2);
        assert!(raw.next.is_some());
    }

    #[test]
    fn extracts_epub_and_cover_urls() {
        let raw: GxPage = serde_json::from_str(SAMPLE_PAGE).unwrap();
        let page = project_page(raw, 1);

        // 音频本被过滤掉 —— 搜索结果里不该出现没法下载的书
        assert_eq!(page.results.len(), 1);

        let book = &page.results[0];
        assert_eq!(book.id, 24264);
        assert_eq!(book.title, "紅樓夢");
        assert_eq!(book.author, "Cao, Xueqin");
        assert_eq!(
            book.epub_url.as_deref(),
            Some("https://www.gutenberg.org/cache/epub/24264/pg24264.epub")
        );
        assert_eq!(
            book.cover_url.as_deref(),
            Some("https://www.gutenberg.org/cache/epub/24264/pg24264.cover.medium.jpg")
        );
        assert_eq!(book.download_count, 9312);
    }

    #[test]
    fn a_book_without_epub_has_no_download_url() {
        let raw: GxPage = serde_json::from_str(SAMPLE_PAGE).unwrap();
        let audio_book = raw.results.into_iter().find(|b| b.id == 20968).unwrap();
        let projected = CatalogBook::from(audio_book);

        assert!(projected.epub_url.is_none());
        assert!(projected.cover_url.is_some());
    }

    #[test]
    fn falls_back_to_unknown_author_and_tolerates_missing_fields() {
        let raw: GxPage =
            serde_json::from_str(r#"{"count":1,"results":[{"id":7,"title":"无名"}]}"#).unwrap();
        let projected = CatalogBook::from(raw.results.into_iter().next().unwrap());

        assert_eq!(projected.author, "Unknown Author");
        assert!(projected.languages.is_empty());
        assert_eq!(projected.download_count, 0);
        assert!(projected.epub_url.is_none());
    }

    #[test]
    fn accepts_only_gutenberg_https_epub_urls() {
        // Gutenberg 实际在用的五种 EPUB 直链写法，一个都不能漏。
        // `.epub3.images` 是 Gutendex 现在返回得最多的那种 ——
        // 早期版本只认「以 .epub 结尾」，结果把每一条真实下载都拒了。
        for url in [
            "https://www.gutenberg.org/cache/epub/24264/pg24264.epub",
            "https://www.gutenberg.org/ebooks/23962.epub3.images",
            "https://www.gutenberg.org/ebooks/23962.epub3.noimages",
            "https://www.gutenberg.org/ebooks/23962.epub.images",
            "https://www.gutenberg.org/ebooks/23962.epub.noimages",
            "https://gutenberg.org/x.epub",
        ] {
            assert!(validate_epub_url(url).is_ok(), "should accept {}", url);
        }

        // 别的域名一律拒绝 —— 这个功能只能是公版书下载器
        assert!(validate_epub_url("https://example.com/book.epub").is_err());
        assert!(validate_epub_url("https://zh.z-library.biz/book.epub").is_err());
        // http 不行
        assert!(validate_epub_url("http://www.gutenberg.org/x.epub").is_err());
        // 非 epub
        assert!(validate_epub_url("https://www.gutenberg.org/x.pdf").is_err());
        assert!(validate_epub_url("https://www.gutenberg.org/files/24264/24264-0.txt").is_err());
        // 伪装成 gutenberg 的子域也不行
        assert!(validate_epub_url("https://evil-gutenberg.org/x.epub").is_err());
    }

    /// 重定向策略只在联网时才真正跑得起来（要有个会 302 的服务器），
    /// 所以这里只锁住「白名单就是这两个主机」这个前提，
    /// 行为本身由 `real_download_and_import` 走 `.epub3.images` 那条
    /// 会 302 的链路来验证。
    #[test]
    fn redirect_allowlist_covers_gutenberg_hosts() {
        assert!(ALLOWED_HOSTS.contains(&"www.gutenberg.org"));
        assert!(ALLOWED_HOSTS.contains(&"gutenberg.org"));
        // 白名单里绝不能出现别的站点
        assert_eq!(ALLOWED_HOSTS.len(), 2);
    }

    /// 真实联网冒烟测试，默认跳过：
    /// `DAZIJI_NET_TESTS=1 cargo test --no-default-features --lib -- --nocapture real_gutendex`
    #[test]
    fn real_gutendex_search() {
        if std::env::var("DAZIJI_NET_TESTS").is_err() {
            println!("DAZIJI_NET_TESTS not set — skipping");
            return;
        }

        let page = tauri::async_runtime::block_on(search_gutendex(
            "西游".to_string(),
            "zh".to_string(),
            1,
        ))
        .expect("search must succeed");

        println!("count={} returned={}", page.count, page.results.len());
        assert!(page.count > 0);
        assert!(!page.results.is_empty());
        assert!(page.results.iter().all(|b| b.epub_url.is_some()));
    }

    /// 真实下载 + 导入的端到端冒烟测试（默认跳过，同样由 `DAZIJI_NET_TESTS` 门控）。
    ///
    /// 覆盖的是整条链路里最容易悄悄坏掉、又最难在单元测试里发现的部分：
    /// 流式写盘有没有真的写出完整文件、下载下来的 EPUB 能不能被导入、
    /// source_id 有没有落库。用《紅樓夢》(id 24264) —— 中文古典小说，
    /// 正好也验证 Strategy 1.5 的重切分。
    #[test]
    fn real_download_and_import() {
        if std::env::var("DAZIJI_NET_TESTS").is_err() {
            println!("DAZIJI_NET_TESTS not set — skipping");
            return;
        }

        let work_dir = std::env::temp_dir().join(format!("daziji-dl-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&work_dir).unwrap();

        let database = crate::db::Database::new(&work_dir.join("test.db")).unwrap();
        let state = crate::AppState {
            db: std::sync::Mutex::new(database),
        };

        // 刻意用 Gutendex 实际返回的那种 URL 形态（`.epub3.images`，会 302），
        // 而不是手写一条 `/cache/epub/.../pgXXXX.epub` —— 上一版就是因为
        // 测试里用了后者，才没发现真实下载全被 URL 校验拒了。
        let url = validate_epub_url("https://www.gutenberg.org/ebooks/24264.epub3.images")
            .expect("url must validate");
        let staging = work_dir.join("book.epub");

        let mut final_received = 0u64;
        tauri::async_runtime::block_on(download_to_file(&url, &staging, |p| {
            final_received = p.received;
        }))
        .expect("download must succeed");

        let on_disk = std::fs::metadata(&staging).unwrap().len();
        println!("downloaded {} bytes (last progress reported {})", on_disk, final_received);
        assert!(on_disk > 100_000, "file looks truncated: {} bytes", on_disk);
        assert_eq!(on_disk, final_received, "progress total disagrees with file size");

        // 书库下载一律开繁→简（用户的默认选择），顺便验证转换真的生效
        let imported = super::super::import::import_from_path(
            &state,
            &staging.to_string_lossy(),
            Some("24264"),
            true,
        )
        .expect("import must succeed");

        println!(
            "imported {:?} by {:?} — {} chapters, {} words",
            imported.title, imported.author, imported.chapter_count, imported.total_words
        );
        // 古典小说的回目必须切出来，而不是塌成 1-2 章
        assert!(
            imported.chapter_count > 50,
            "expected the novel to split into many chapters, got {}",
            imported.chapter_count
        );
        assert_eq!(imported.source_id.as_deref(), Some("24264"));

        // 繁→简确实生效：书名与首章标题都该是简体
        assert_eq!(imported.title, "红楼梦", "书名应转成简体，实际 {:?}", imported.title);
        let first = state
            .db
            .lock()
            .unwrap()
            .get_chapters(&imported.id)
            .unwrap()
            .into_iter()
            .next()
            .expect("book must have chapters");
        println!("首章标题（简体）：{:?}", first.title);
        // 「第一回」在两个字形下相同，但回目正文必然出现繁体特征字
        assert!(
            !first.content.contains('賈') && !first.content.contains('寶'),
            "正文里不该残留繁体字（賈/寶）"
        );

        std::fs::remove_dir_all(&work_dir).ok();
    }
}

