use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    ffi::c_void,
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, Position, Size, WebviewWindow};
use tokio::sync::oneshot;
use uuid::Uuid;
#[cfg(target_os = "windows")]
use windows_sys::Win32::Graphics::Dwm::DwmSetWindowAttribute;
#[cfg(target_os = "windows")]
use winreg::{enums::HKEY_CURRENT_USER, RegKey};

const XAI_API_BASE: &str = "https://api.x.ai/v1";
const XAI_IMAGE_MODEL: &str = "grok-imagine-image";
const GEMINI_API_BASE: &str = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_IMAGE_MODEL: &str = "gemini-2.5-flash-image";
const BFL_API_BASE: &str = "https://api.bfl.ai/v1";
const BFL_FLUX_PRO_PATH: &str = "flux-pro-1.1";
const BFL_KONTEXT_PATH: &str = "flux-kontext-pro";
const BFL_POLL_INTERVAL_MS: u64 = 1500;
const BFL_MAX_POLLS: u32 = 120; // ~3 min ceiling, matching IMAGE_TIMEOUT_SECS
const IMAGE_TIMEOUT_SECS: u64 = 180;

// Providers whose API keys are stored/managed in Settings: (id, label, env var name).
// Generation providers map onto these (both FLUX models share the one BFL key).
const KEY_PROVIDERS: &[(&str, &str, &str)] = &[
    ("xai", "xAI", "XAI_API_KEY"),
    ("google", "Google (Gemini)", "GOOGLE_API_KEY"),
    ("bfl", "Black Forest Labs", "BFL_API_KEY"),
];

fn key_provider_env(provider_id: &str) -> Option<&'static str> {
    KEY_PROVIDERS
        .iter()
        .find(|(id, _, _)| *id == provider_id)
        .map(|(_, _, env)| *env)
}

// Maps a generation provider (chosen per-request in the UI) to the env var that holds its key.
fn generation_key_env(provider: &str) -> Option<&'static str> {
    match provider {
        "xai" => Some("XAI_API_KEY"),
        "google" => Some("GOOGLE_API_KEY"),
        "flux-pro" | "flux-kontext" => Some("BFL_API_KEY"),
        _ => None,
    }
}
const INDEX_LOCK_TIMEOUT_MS: u128 = 10_000;
const STALE_INDEX_LOCK_MS: u128 = 120_000;
const SETTINGS_FILE: &str = "settings.json";
const WINDOW_SIZE_KIND_INNER: &str = "inner";
const BORDERLESS_EDGE_EXPAND: i32 = 2;

#[cfg(target_os = "windows")]
const DWMWA_WINDOW_CORNER_PREFERENCE: u32 = 33;
#[cfg(target_os = "windows")]
const DWMWCP_DEFAULT: u32 = 0;
#[cfg(target_os = "windows")]
const DWMWCP_DONOTROUND: u32 = 1;

#[derive(Default)]
struct AppState {
    current_generation: Mutex<Option<oneshot::Sender<()>>>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowState {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    #[serde(default)]
    size_kind: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowBounds {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    #[serde(default = "default_true")]
    remember_window_position: bool,
    #[serde(default)]
    auto_open_last_fill_view: bool,
    #[serde(default)]
    square_app_corners: bool,
    #[serde(default)]
    expand_borderless_edges: bool,
    #[serde(default)]
    window: Option<WindowState>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            remember_window_position: true,
            auto_open_last_fill_view: false,
            square_app_corners: false,
            expand_borderless_edges: false,
            window: None,
        }
    }
}

#[derive(Debug, Deserialize, Serialize, Clone)]
struct GalleryEntry {
    file: String,
    #[serde(default)]
    prompt: String,
    #[serde(default)]
    timestamp: String,
    #[serde(default, rename = "sourceKey")]
    source_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GenerateArgs {
    prompt: String,
    n: Option<u8>,
    #[serde(default)]
    provider: Option<String>,
    // Source image for edit models (FLUX.1 Kontext). Same shape as other image payloads.
    #[serde(default)]
    input_image: Option<ImagePayload>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImagePayload {
    data_url: Option<String>,
    file_path: Option<String>,
    target_path: Option<String>,
    prompt: Option<String>,
    source_key: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImageRef {
    src: String,
    file_path: String,
    prompt: String,
    source_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    data_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    saved: Option<bool>,
}

#[derive(Debug, Serialize)]
struct ErrorResult {
    error: String,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
enum GenerateResult {
    Ok {
        images: Vec<String>,
        files: Vec<String>,
        #[serde(rename = "sourceKeys")]
        source_keys: Vec<String>,
    },
    Err(ErrorResult),
}

#[derive(Debug, Deserialize)]
struct XaiImage {
    b64_json: String,
}

#[derive(Debug, Deserialize)]
struct XaiImageResponse {
    data: Option<Vec<XaiImage>>,
}

// ── Gemini (Nano Banana) response shape ──
#[derive(Debug, Deserialize)]
struct GeminiInlineData {
    data: String,
    #[serde(rename = "mimeType")]
    mime_type: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GeminiPart {
    #[serde(rename = "inlineData")]
    inline_data: Option<GeminiInlineData>,
}

#[derive(Debug, Deserialize)]
struct GeminiContent {
    #[serde(default)]
    parts: Vec<GeminiPart>,
}

#[derive(Debug, Deserialize)]
struct GeminiCandidate {
    content: Option<GeminiContent>,
}

#[derive(Debug, Deserialize)]
struct GeminiResponse {
    #[serde(default)]
    candidates: Vec<GeminiCandidate>,
}

// ── Black Forest Labs (FLUX) async job shape ──
#[derive(Debug, Deserialize)]
struct BflCreateResponse {
    id: Option<String>,
    polling_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct BflResultInner {
    sample: Option<String>,
}

#[derive(Debug, Deserialize)]
struct BflPollResponse {
    status: String,
    result: Option<BflResultInner>,
}

struct AppPaths {
    data_dir: PathBuf,
    gallery_dir: PathBuf,
    gallery_index: PathBuf,
    gallery_archive_dir: PathBuf,
    gallery_lock: PathBuf,
    display_dir: PathBuf,
    display_index: PathBuf,
    display_archive_dir: PathBuf,
    display_lock: PathBuf,
}

fn app_paths(app: &AppHandle) -> Result<AppPaths, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?;
    let gallery_dir = data_dir.join("gallery");
    let display_dir = data_dir.join("display-gallery");

    Ok(AppPaths {
        gallery_index: gallery_dir.join("index.json"),
        gallery_archive_dir: gallery_dir.join("archived"),
        gallery_lock: gallery_dir.join(".index.lock"),
        display_index: display_dir.join("index.json"),
        display_archive_dir: display_dir.join("archived"),
        display_lock: display_dir.join(".index.lock"),
        gallery_dir,
        display_dir,
        data_dir,
    })
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?
        .join(SETTINGS_FILE))
}

fn load_settings_inner(app: &AppHandle) -> Settings {
    settings_path(app)
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|data| serde_json::from_str::<Settings>(&data).ok())
        .unwrap_or_default()
}

fn save_settings_inner(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let path = settings_path(app)?;
    if let Some(parent) = path.parent() {
        ensure_dir(parent)?;
    }
    let data = serde_json::to_string_pretty(settings)
        .map_err(|error| format!("Failed to serialize settings: {error}"))?;
    fs::write(path, data).map_err(|error| format!("Failed to save settings: {error}"))
}

fn ensure_dir(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|error| format!("Failed to create directory: {error}"))
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn timestamp() -> String {
    now_ms().to_string()
}

fn archive_name() -> String {
    format!("grok-imagine-outputs-{}", timestamp())
}

fn sanitize_prompt(prompt: impl AsRef<str>) -> String {
    prompt.as_ref().trim().chars().take(4000).collect()
}

fn sanitize_source_key(source_key: Option<&String>) -> String {
    source_key
        .filter(|key| key.len() <= 180)
        .cloned()
        .unwrap_or_default()
}

fn sanitize_count(n: Option<u8>) -> u8 {
    n.filter(|count| (1..=4).contains(count)).unwrap_or(1)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn source_key_from_bytes(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    format!("sha256:{}", hex(&digest))
}

fn data_url_to_bytes(data_url: &str) -> Result<Vec<u8>, String> {
    // Accept any `data:<mime>;base64,` prefix (xAI/BFL are PNG, Gemini may vary).
    let encoded = data_url
        .split_once("base64,")
        .map(|(_, encoded)| encoded)
        .ok_or_else(|| "Invalid image data.".to_string())?;
    general_purpose::STANDARD
        .decode(encoded)
        .map_err(|error| format!("Invalid image data: {error}"))
}

fn bytes_to_data_url(bytes: &[u8]) -> String {
    format!(
        "data:image/png;base64,{}",
        general_purpose::STANDARD.encode(bytes)
    )
}

fn read_index(index_file: &Path) -> Vec<GalleryEntry> {
    fs::read_to_string(index_file)
        .ok()
        .and_then(|data| serde_json::from_str::<Vec<GalleryEntry>>(&data).ok())
        .unwrap_or_default()
        .into_iter()
        .filter(|entry| {
            Path::new(&entry.file)
                .file_name()
                .and_then(|name| name.to_str())
                == Some(entry.file.as_str())
        })
        .collect()
}

fn write_index(index_file: &Path, index: &[GalleryEntry]) -> Result<(), String> {
    let temp_file = index_file.with_extension(format!("json.{}.tmp", now_ms()));
    let data = serde_json::to_string(index)
        .map_err(|error| format!("Failed to serialize gallery index: {error}"))?;
    fs::write(&temp_file, data)
        .map_err(|error| format!("Failed to write gallery index: {error}"))?;
    fs::rename(&temp_file, index_file)
        .map_err(|error| format!("Failed to replace gallery index: {error}"))
}

fn remove_stale_lock(lock_file: &Path) {
    if let Ok(metadata) = fs::metadata(lock_file) {
        if let Ok(modified) = metadata.modified() {
            if modified
                .elapsed()
                .map(|elapsed| elapsed.as_millis() > STALE_INDEX_LOCK_MS)
                .unwrap_or(false)
            {
                let _ = fs::remove_file(lock_file);
            }
        }
    }
}

fn with_index_lock<T>(
    dir: &Path,
    lock_file: &Path,
    task: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    ensure_dir(dir)?;
    let started = now_ms();
    let mut lock_handle: Option<File> = None;

    while lock_handle.is_none() {
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(lock_file)
        {
            Ok(mut file) => {
                let _ = writeln!(
                    file,
                    "{{\"pid\":{},\"startedAt\":\"{}\"}}",
                    std::process::id(),
                    timestamp()
                );
                lock_handle = Some(file);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                remove_stale_lock(lock_file);
                if now_ms().saturating_sub(started) > INDEX_LOCK_TIMEOUT_MS {
                    return Err("Timed out waiting for gallery index lock.".into());
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(error) => return Err(format!("Failed to create gallery index lock: {error}")),
        }
    }

    let result = task();
    drop(lock_handle);
    let _ = fs::remove_file(lock_file);
    result
}

fn resolve_file_in_dir(file_path: Option<&String>, dir: &Path) -> Option<PathBuf> {
    let file_path = file_path?;
    let resolved = fs::canonicalize(file_path).ok()?;
    let resolved_dir = fs::canonicalize(dir).ok()?;
    if resolved.starts_with(resolved_dir) {
        Some(resolved)
    } else {
        None
    }
}

fn read_image_payload(payload: &ImagePayload, paths: &AppPaths) -> Result<Vec<u8>, String> {
    if let Some(data_url) = &payload.data_url {
        return data_url_to_bytes(data_url);
    }

    if let Some(file) = resolve_file_in_dir(payload.file_path.as_ref(), &paths.gallery_dir)
        .or_else(|| resolve_file_in_dir(payload.file_path.as_ref(), &paths.display_dir))
    {
        return fs::read(file).map_err(|error| format!("Failed to read image: {error}"));
    }

    Err("Image data is required.".into())
}

fn source_key_from_payload(
    payload: &ImagePayload,
    bytes: Option<&[u8]>,
    paths: &AppPaths,
) -> String {
    let provided = sanitize_source_key(payload.source_key.as_ref());
    if !provided.is_empty() {
        return provided;
    }

    if let Some(file) = resolve_file_in_dir(payload.file_path.as_ref(), &paths.gallery_dir) {
        if let Some(name) = file.file_name().and_then(|name| name.to_str()) {
            return format!("gallery:{name}");
        }
    }

    if let Some(file) = resolve_file_in_dir(payload.file_path.as_ref(), &paths.display_dir) {
        if let Some(name) = file.file_name().and_then(|name| name.to_str()) {
            return format!("display:{name}");
        }
    }

    bytes.map(source_key_from_bytes).unwrap_or_default()
}

fn entry_to_image_ref(dir: &Path, entry: &GalleryEntry, source_key: String) -> Option<ImageRef> {
    let file_path = dir.join(&entry.file);
    let bytes = fs::read(&file_path).ok()?;
    Some(ImageRef {
        src: bytes_to_data_url(&bytes),
        file_path: file_path.to_string_lossy().to_string(),
        prompt: entry.prompt.clone(),
        source_key,
        data_url: None,
        saved: None,
    })
}

// Lightweight variant: verifies the file exists but does not read it.
// The frontend derives the display URL via the asset protocol.
fn entry_to_image_ref_lite(dir: &Path, entry: &GalleryEntry, source_key: String) -> Option<ImageRef> {
    let file_path = dir.join(&entry.file);
    if !file_path.is_file() {
        return None;
    }
    Some(ImageRef {
        src: String::new(),
        file_path: file_path.to_string_lossy().to_string(),
        prompt: entry.prompt.clone(),
        source_key,
        data_url: None,
        saved: None,
    })
}

fn display_entry_source_key(entry: &GalleryEntry) -> String {
    if entry.source_key.is_empty() {
        format!("display:{}", entry.file)
    } else {
        entry.source_key.clone()
    }
}

fn save_gallery_images(
    app: &AppHandle,
    data_urls: &[String],
    prompt: &str,
) -> Result<Vec<ImageRef>, String> {
    let paths = app_paths(app)?;
    with_index_lock(&paths.gallery_dir, &paths.gallery_lock, || {
        let mut index = read_index(&paths.gallery_index);
        let base = format!("{}-{}", now_ms(), std::process::id());
        let mut saved = Vec::new();

        for (i, data_url) in data_urls.iter().enumerate() {
            let file = format!("img-{base}-{i}.png");
            let file_path = paths.gallery_dir.join(&file);
            let bytes = data_url_to_bytes(data_url)?;
            fs::write(&file_path, bytes)
                .map_err(|error| format!("Failed to save image: {error}"))?;
            index.insert(
                0,
                GalleryEntry {
                    file: file.clone(),
                    prompt: prompt.to_string(),
                    timestamp: timestamp(),
                    source_key: String::new(),
                },
            );
            saved.push(ImageRef {
                src: data_url.clone(),
                file_path: file_path.to_string_lossy().to_string(),
                prompt: prompt.to_string(),
                source_key: format!("gallery:{file}"),
                data_url: Some(data_url.clone()),
                saved: None,
            });
        }

        write_index(&paths.gallery_index, &index)?;
        Ok(saved)
    })
}

fn load_env_file(app: &AppHandle) {
    let cwd_env = std::env::current_dir().ok().map(|cwd| cwd.join(".env"));
    let app_env = app.path().resource_dir().ok().map(|dir| dir.join(".env"));

    for env_file in [cwd_env, app_env].into_iter().flatten() {
        if let Ok(data) = fs::read_to_string(env_file) {
            for line in data.lines() {
                let line = line.trim();
                if line.is_empty() || line.starts_with('#') {
                    continue;
                }
                if let Some((key, value)) = line.split_once('=') {
                    if std::env::var_os(key.trim()).is_none() {
                        std::env::set_var(key.trim(), value.trim().trim_matches('"'));
                    }
                }
            }
        }
    }
}

fn valid_api_key(key: &str) -> bool {
    !key.trim().is_empty() && key.trim() != "your-api-key-here"
}

fn masked_key_tail(key: &str) -> String {
    let key = key.trim();
    key.chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

fn credential_target(key_name: &str) -> String {
    format!("Grokodrillo/{key_name}")
}

#[cfg(target_os = "windows")]
fn windows_user_env(name: &str) -> Option<String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let env = hkcu.open_subkey("Environment").ok()?;
    let value: String = env.get_value(name).ok()?;
    let value = value.trim().to_string();
    valid_api_key(&value).then_some(value)
}

#[cfg(not(target_os = "windows"))]
fn windows_user_env(_name: &str) -> Option<String> {
    None
}

#[cfg(target_os = "windows")]
#[repr(C)]
struct CredentialW {
    flags: u32,
    credential_type: u32,
    target_name: *mut u16,
    comment: *mut u16,
    last_written: FileTime,
    credential_blob_size: u32,
    credential_blob: *mut u8,
    persist: u32,
    attribute_count: u32,
    attributes: *mut c_void,
    target_alias: *mut u16,
    user_name: *mut u16,
}

#[cfg(target_os = "windows")]
#[repr(C)]
struct FileTime {
    low_date_time: u32,
    high_date_time: u32,
}

#[cfg(target_os = "windows")]
#[link(name = "Advapi32")]
extern "system" {
    fn CredReadW(
        target_name: *const u16,
        credential_type: u32,
        flags: u32,
        credential: *mut *mut CredentialW,
    ) -> i32;
    fn CredWriteW(credential: *const CredentialW, flags: u32) -> i32;
    fn CredDeleteW(target_name: *const u16, credential_type: u32, flags: u32) -> i32;
    fn CredFree(buffer: *mut c_void);
}

#[cfg(target_os = "windows")]
fn wide_null(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(target_os = "windows")]
fn credential_read(key_name: &str) -> Option<String> {
    const CRED_TYPE_GENERIC: u32 = 1;

    let target = wide_null(&credential_target(key_name));
    let mut credential_ptr: *mut CredentialW = std::ptr::null_mut();
    let ok = unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut credential_ptr) };
    if ok == 0 || credential_ptr.is_null() {
        return None;
    }

    let credential = unsafe { &*credential_ptr };
    let bytes = unsafe {
        std::slice::from_raw_parts(
            credential.credential_blob,
            credential.credential_blob_size as usize,
        )
    };
    let value = String::from_utf8_lossy(bytes).trim().to_string();
    unsafe { CredFree(credential_ptr as *mut c_void) };

    valid_api_key(&value).then_some(value)
}

#[cfg(not(target_os = "windows"))]
fn credential_read(_key_name: &str) -> Option<String> {
    None
}

#[cfg(target_os = "windows")]
fn credential_write(key_name: &str, key: &str) -> Result<(), String> {
    const CRED_TYPE_GENERIC: u32 = 1;
    const CRED_PERSIST_LOCAL_MACHINE: u32 = 2;

    let mut target = wide_null(&credential_target(key_name));
    let mut username = wide_null("Grokodrillo");
    let mut blob = key.trim().as_bytes().to_vec();
    if blob.is_empty() {
        return Err("API key cannot be empty.".to_string());
    }

    let credential = CredentialW {
        flags: 0,
        credential_type: CRED_TYPE_GENERIC,
        target_name: target.as_mut_ptr(),
        comment: std::ptr::null_mut(),
        last_written: FileTime {
            low_date_time: 0,
            high_date_time: 0,
        },
        credential_blob_size: blob.len() as u32,
        credential_blob: blob.as_mut_ptr(),
        persist: CRED_PERSIST_LOCAL_MACHINE,
        attribute_count: 0,
        attributes: std::ptr::null_mut(),
        target_alias: std::ptr::null_mut(),
        user_name: username.as_mut_ptr(),
    };

    let ok = unsafe { CredWriteW(&credential, 0) };
    if ok == 0 {
        return Err("Windows Credential Manager could not save the API key.".to_string());
    }

    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn credential_write(_key_name: &str, _key: &str) -> Result<(), String> {
    Err("Credential Manager storage is only available on Windows.".to_string())
}

#[cfg(target_os = "windows")]
fn credential_delete(key_name: &str) -> Result<(), String> {
    const CRED_TYPE_GENERIC: u32 = 1;
    let target = wide_null(&credential_target(key_name));
    let _ = unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) };
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn credential_delete(_key_name: &str) -> Result<(), String> {
    Err("Credential Manager storage is only available on Windows.".to_string())
}

fn configured_api_key_for(env_name: &str) -> Option<String> {
    if let Some(key) = credential_read(env_name) {
        std::env::set_var(env_name, &key);
        return Some(key);
    }

    if let Ok(key) = std::env::var(env_name) {
        if valid_api_key(&key) {
            return Some(key);
        }
    }

    let key = windows_user_env(env_name)?;
    std::env::set_var(env_name, &key);
    Some(key)
}

fn provider_status(id: &str, label: &str, env_name: &str) -> Value {
    let credential_key = credential_read(env_name);
    let env_key = std::env::var(env_name).ok().filter(|key| valid_api_key(key));
    let user_env_key = windows_user_env(env_name);
    let active_key = credential_key
        .as_ref()
        .or(env_key.as_ref())
        .or(user_env_key.as_ref());
    let source = if credential_key.is_some() {
        "Windows Credential Manager"
    } else if env_key.is_some() {
        "Environment or .env"
    } else if user_env_key.is_some() {
        "Windows user environment"
    } else {
        "Not set"
    };

    json!({
        "id": id,
        "label": label,
        "configured": active_key.is_some(),
        "savedInCredentialManager": credential_key.is_some(),
        "source": source,
        "last4": active_key.map(|key| masked_key_tail(key)).unwrap_or_default(),
    })
}

#[tauri::command]
fn check_api_key() -> bool {
    KEY_PROVIDERS
        .iter()
        .any(|(_, _, env)| configured_api_key_for(env).is_some())
}

#[tauri::command]
fn api_key_status() -> Result<Value, String> {
    Ok(Value::Array(
        KEY_PROVIDERS
            .iter()
            .map(|(id, label, env)| provider_status(id, label, env))
            .collect(),
    ))
}

#[tauri::command]
fn api_key_save(provider_id: String, key: String) -> Result<Value, String> {
    let env_name = key_provider_env(&provider_id).ok_or("Unknown API provider.")?;
    if !valid_api_key(&key) {
        return Err("Enter a valid API key.".to_string());
    }

    credential_write(env_name, key.trim())?;
    std::env::set_var(env_name, key.trim());
    api_key_status()
}

#[tauri::command]
fn api_key_delete(provider_id: String) -> Result<Value, String> {
    let env_name = key_provider_env(&provider_id).ok_or("Unknown API provider.")?;

    let saved_key = credential_read(env_name);
    credential_delete(env_name)?;
    if let (Some(saved), Ok(current)) = (saved_key, std::env::var(env_name)) {
        if current.trim() == saved.trim() {
            std::env::remove_var(env_name);
        }
    }
    api_key_status()
}

#[tauri::command]
fn is_primary_instance() -> bool {
    true
}

// Each provider returns a list of `data:<mime>;base64,…` image URLs.
async fn xai_generate(
    client: &reqwest::Client,
    api_key: &str,
    prompt: &str,
    n: u8,
) -> Result<Vec<String>, String> {
    let response = client
        .post(format!("{XAI_API_BASE}/images/generations"))
        .bearer_auth(api_key)
        .json(&json!({
            "model": XAI_IMAGE_MODEL,
            "prompt": prompt,
            "n": n,
            "response_format": "b64_json"
        }))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("API error {status}: {body}"));
    }
    let data = response
        .json::<XaiImageResponse>()
        .await
        .map_err(|error| error.to_string())?;
    Ok(data
        .data
        .unwrap_or_default()
        .into_iter()
        .map(|image| format!("data:image/png;base64,{}", image.b64_json))
        .collect())
}

async fn gemini_generate(
    client: &reqwest::Client,
    api_key: &str,
    prompt: &str,
) -> Result<Vec<String>, String> {
    let response = client
        .post(format!(
            "{GEMINI_API_BASE}/models/{GEMINI_IMAGE_MODEL}:generateContent"
        ))
        .header("x-goog-api-key", api_key)
        .json(&json!({ "contents": [{ "parts": [{ "text": prompt }] }] }))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("API error {status}: {body}"));
    }
    let data = response
        .json::<GeminiResponse>()
        .await
        .map_err(|error| error.to_string())?;
    let images = data
        .candidates
        .into_iter()
        .filter_map(|candidate| candidate.content)
        .flat_map(|content| content.parts)
        .filter_map(|part| part.inline_data)
        .map(|inline| {
            let mime = inline.mime_type.unwrap_or_else(|| "image/png".to_string());
            format!("data:{mime};base64,{}", inline.data)
        })
        .collect::<Vec<_>>();
    if images.is_empty() {
        return Err("Gemini returned no image (the prompt may have been blocked).".into());
    }
    Ok(images)
}

async fn bfl_generate(
    client: &reqwest::Client,
    api_key: &str,
    path: &str,
    body: Value,
) -> Result<Vec<String>, String> {
    let create = client
        .post(format!("{BFL_API_BASE}/{path}"))
        .header("x-key", api_key)
        .json(&body)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !create.status().is_success() {
        let status = create.status();
        let text = create.text().await.unwrap_or_default();
        return Err(format!("API error {status}: {text}"));
    }
    let created = create
        .json::<BflCreateResponse>()
        .await
        .map_err(|error| error.to_string())?;
    let polling_url = created
        .polling_url
        .or_else(|| {
            created
                .id
                .map(|id| format!("{BFL_API_BASE}/get_result?id={id}"))
        })
        .ok_or_else(|| "Black Forest Labs did not return a job URL.".to_string())?;

    for _ in 0..BFL_MAX_POLLS {
        tokio::time::sleep(Duration::from_millis(BFL_POLL_INTERVAL_MS)).await;
        let poll = client
            .get(&polling_url)
            .header("x-key", api_key)
            .send()
            .await
            .map_err(|error| error.to_string())?;
        if !poll.status().is_success() {
            let status = poll.status();
            let text = poll.text().await.unwrap_or_default();
            return Err(format!("API error {status}: {text}"));
        }
        let update = poll
            .json::<BflPollResponse>()
            .await
            .map_err(|error| error.to_string())?;
        match update.status.as_str() {
            "Ready" => {
                let url = update
                    .result
                    .and_then(|result| result.sample)
                    .ok_or_else(|| "Black Forest Labs result was missing an image.".to_string())?;
                let bytes = client
                    .get(&url)
                    .send()
                    .await
                    .map_err(|error| error.to_string())?
                    .bytes()
                    .await
                    .map_err(|error| error.to_string())?;
                return Ok(vec![bytes_to_data_url(&bytes)]);
            }
            "Pending" => continue,
            other => return Err(format!("Black Forest Labs job failed: {other}")),
        }
    }
    Err("Timed out waiting for the Black Forest Labs result.".into())
}

#[tauri::command]
async fn generate_image(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    args: GenerateArgs,
) -> Result<GenerateResult, String> {
    let provider = args.provider.clone().unwrap_or_else(|| "xai".to_string());

    let env_name = match generation_key_env(&provider) {
        Some(env) => env,
        None => {
            return Ok(GenerateResult::Err(ErrorResult {
                error: format!("Unknown provider '{provider}'."),
            }))
        }
    };

    let api_key = match configured_api_key_for(env_name) {
        Some(key) => key,
        None => {
            return Ok(GenerateResult::Err(ErrorResult {
                error: "API key not configured for this model. Add it in Settings.".into(),
            }))
        }
    };

    let prompt = sanitize_prompt(args.prompt);
    if prompt.is_empty() {
        return Ok(GenerateResult::Err(ErrorResult {
            error: "Prompt is required.".into(),
        }));
    }

    // Edit models (FLUX.1 Kontext) need a source image; read it up-front so a
    // missing/unreadable image fails clearly before we mark a generation in progress.
    let input_image_b64 = if provider == "flux-kontext" {
        let paths = app_paths(&app)?;
        match args
            .input_image
            .as_ref()
            .and_then(|payload| read_image_payload(payload, &paths).ok())
        {
            Some(bytes) => Some(general_purpose::STANDARD.encode(&bytes)),
            None => {
                return Ok(GenerateResult::Err(ErrorResult {
                    error: "FLUX.1 Kontext needs a source image — open an image and choose Edit."
                        .into(),
                }))
            }
        }
    } else {
        None
    };

    let (cancel_tx, cancel_rx) = oneshot::channel();
    {
        let mut current = match state.current_generation.lock() {
            Ok(current) => current,
            Err(error) => {
                return Ok(GenerateResult::Err(ErrorResult {
                    error: error.to_string(),
                }))
            }
        };
        if current.is_some() {
            return Ok(GenerateResult::Err(ErrorResult {
                error: "Generation already in progress.".into(),
            }));
        }
        *current = Some(cancel_tx);
    }

    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(IMAGE_TIMEOUT_SECS))
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            if let Ok(mut current) = state.current_generation.lock() {
                *current = None;
            }
            return Ok(GenerateResult::Err(ErrorResult {
                error: error.to_string(),
            }));
        }
    };

    let n = sanitize_count(args.n);
    let generation = async {
        match provider.as_str() {
            "xai" => xai_generate(&client, &api_key, &prompt, n).await,
            "google" => gemini_generate(&client, &api_key, &prompt).await,
            "flux-pro" => {
                bfl_generate(
                    &client,
                    &api_key,
                    BFL_FLUX_PRO_PATH,
                    json!({ "prompt": prompt.clone(), "output_format": "png" }),
                )
                .await
            }
            "flux-kontext" => {
                bfl_generate(
                    &client,
                    &api_key,
                    BFL_KONTEXT_PATH,
                    json!({
                        "prompt": prompt.clone(),
                        "input_image": input_image_b64.clone().unwrap_or_default(),
                        "output_format": "png"
                    }),
                )
                .await
            }
            other => Err(format!("Unknown provider '{other}'.")),
        }
    };

    let result = tokio::select! {
        _ = cancel_rx => Err("cancelled".to_string()),
        images = generation => match images {
            Ok(images) => save_gallery_images(&app, &images, &prompt).map(|saved| (images, saved)),
            Err(error) => Err(error),
        },
    };

    if let Ok(mut current) = state.current_generation.lock() {
        *current = None;
    }

    match result {
        Ok((images, saved)) => Ok(GenerateResult::Ok {
            images,
            files: saved.iter().map(|entry| entry.file_path.clone()).collect(),
            source_keys: saved.iter().map(|entry| entry.source_key.clone()).collect(),
        }),
        Err(error) => Ok(GenerateResult::Err(ErrorResult { error })),
    }
}

#[tauri::command]
fn cancel_generation(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    if let Some(cancel) = state
        .current_generation
        .lock()
        .map_err(|error| error.to_string())?
        .take()
    {
        let _ = cancel.send(());
    }
    Ok(json!({ "cancelled": true }))
}

#[tauri::command]
fn save_image(app: AppHandle, payload: ImagePayload) -> Result<serde_json::Value, String> {
    let paths = app_paths(&app)?;
    let image = read_image_payload(&payload, &paths)?;
    let target = payload
        .target_path
        .as_ref()
        .map(PathBuf::from)
        .ok_or_else(|| "Save path is required.".to_string())?;
    fs::write(&target, image).map_err(|error| format!("Failed to save image: {error}"))?;
    Ok(json!({ "saved": true, "filePath": target.to_string_lossy() }))
}

#[tauri::command]
fn copy_image(app: AppHandle, payload: ImagePayload) -> Result<serde_json::Value, String> {
    let paths = app_paths(&app)?;
    let image = read_image_payload(&payload, &paths)?;
    let temp_file = std::env::temp_dir().join(format!("grok-imagine-copy-{}.png", now_ms()));
    fs::write(&temp_file, image)
        .map_err(|error| format!("Failed to prepare clipboard image: {error}"))?;

    #[cfg(target_os = "windows")]
    {
        let script = format!(
            "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $img=[System.Drawing.Image]::FromFile('{}'); [System.Windows.Forms.Clipboard]::SetImage($img); $img.Dispose()",
            temp_file.to_string_lossy().replace('\'', "''")
        );
        let output = Command::new("powershell")
            .args(["-NoProfile", "-STA", "-Command", &script])
            .output()
            .map_err(|error| format!("Failed to copy image: {error}"))?;
        let _ = fs::remove_file(&temp_file);
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        Ok(json!({ "copied": true }))
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = fs::remove_file(&temp_file);
        Err("Image clipboard copy is only implemented for Windows in this port.".into())
    }
}

#[tauri::command]
fn load_gallery(app: AppHandle) -> Result<Vec<ImageRef>, String> {
    let paths = app_paths(&app)?;
    ensure_dir(&paths.gallery_dir)?;
    Ok(read_index(&paths.gallery_index)
        .into_iter()
        .filter_map(|entry| {
            entry_to_image_ref(
                &paths.gallery_dir,
                &entry,
                format!("gallery:{}", entry.file),
            )
        })
        .collect())
}

#[tauri::command]
fn load_gallery_page(app: AppHandle, offset: usize, limit: usize) -> Result<Vec<ImageRef>, String> {
    let paths = app_paths(&app)?;
    ensure_dir(&paths.gallery_dir)?;
    Ok(read_index(&paths.gallery_index)
        .into_iter()
        .skip(offset)
        .take(limit.min(100))
        .filter_map(|entry| {
            entry_to_image_ref_lite(
                &paths.gallery_dir,
                &entry,
                format!("gallery:{}", entry.file),
            )
        })
        .collect())
}

#[tauri::command]
fn load_gallery_summary(app: AppHandle) -> Result<serde_json::Value, String> {
    let paths = app_paths(&app)?;
    Ok(json!({ "count": read_index(&paths.gallery_index).len() }))
}

#[tauri::command]
fn archive_gallery(app: AppHandle) -> Result<serde_json::Value, String> {
    let paths = app_paths(&app)?;
    with_index_lock(&paths.gallery_dir, &paths.gallery_lock, || {
        let index = read_index(&paths.gallery_index);
        if index.is_empty() {
            return Ok(json!({ "archived": false, "count": 0 }));
        }

        let archive_dir = paths.gallery_archive_dir.join(archive_name());
        ensure_dir(&archive_dir)?;
        let mut count = 0;
        for entry in &index {
            let source = paths.gallery_dir.join(&entry.file);
            let target = archive_dir.join(&entry.file);
            if fs::rename(source, target).is_ok() {
                count += 1;
            }
        }
        fs::write(
            archive_dir.join("index.json"),
            serde_json::to_string(&index).unwrap_or_default(),
        )
        .map_err(|error| format!("Failed to write archive index: {error}"))?;
        write_index(&paths.gallery_index, &[])?;
        Ok(json!({ "archived": true, "count": count, "folder": archive_dir.to_string_lossy() }))
    })
}

#[tauri::command]
fn save_to_display_gallery(
    app: AppHandle,
    payload: ImagePayload,
) -> Result<serde_json::Value, String> {
    let paths = app_paths(&app)?;
    with_index_lock(&paths.display_dir, &paths.display_lock, || {
        let image = read_image_payload(&payload, &paths)?;
        let source_key = source_key_from_payload(&payload, Some(&image), &paths);
        let mut index = read_index(&paths.display_index);

        if let Some(existing) = index
            .iter()
            .find(|entry| display_entry_source_key(entry) == source_key)
        {
            if let Some(image_ref) =
                entry_to_image_ref(&paths.display_dir, existing, source_key.clone())
            {
                return Ok(json!({ "image": ImageRef { saved: Some(false), ..image_ref } }));
            }
            index.retain(|entry| display_entry_source_key(entry) != source_key);
        }

        let file = format!(
            "display-{}-{}-{}.png",
            now_ms(),
            std::process::id(),
            Uuid::new_v4()
        );
        let file_path = paths.display_dir.join(&file);
        fs::write(&file_path, &image)
            .map_err(|error| format!("Failed to save display image: {error}"))?;
        let entry = GalleryEntry {
            file,
            prompt: sanitize_prompt(payload.prompt.as_deref().unwrap_or_default()),
            timestamp: timestamp(),
            source_key: source_key.clone(),
        };
        index.insert(0, entry.clone());
        write_index(&paths.display_index, &index)?;
        let mut image_ref = entry_to_image_ref(&paths.display_dir, &entry, source_key)
            .ok_or_else(|| "Failed to load saved display image.".to_string())?;
        image_ref.saved = Some(true);
        Ok(json!({ "image": image_ref }))
    })
}

#[tauri::command]
fn remove_from_display_gallery(
    app: AppHandle,
    payload: ImagePayload,
) -> Result<serde_json::Value, String> {
    let paths = app_paths(&app)?;
    with_index_lock(&paths.display_dir, &paths.display_lock, || {
        let source_key = source_key_from_payload(&payload, None, &paths);
        if source_key.is_empty() {
            return Ok(json!({ "removed": false, "count": 0 }));
        }

        let index = read_index(&paths.display_index);
        let mut kept = Vec::new();
        let mut removed = Vec::new();
        for entry in index {
            if display_entry_source_key(&entry) == source_key {
                removed.push(entry);
            } else {
                kept.push(entry);
            }
        }

        if removed.is_empty() {
            return Ok(json!({ "removed": false, "count": 0, "sourceKey": source_key }));
        }

        for entry in &removed {
            let _ = fs::remove_file(paths.display_dir.join(&entry.file));
        }
        write_index(&paths.display_index, &kept)?;
        Ok(json!({ "removed": true, "count": removed.len(), "sourceKey": source_key }))
    })
}

#[tauri::command]
fn load_display_gallery(app: AppHandle) -> Result<Vec<ImageRef>, String> {
    let paths = app_paths(&app)?;
    ensure_dir(&paths.display_dir)?;
    Ok(read_index(&paths.display_index)
        .into_iter()
        .filter_map(|entry| {
            let source_key = display_entry_source_key(&entry);
            entry_to_image_ref_lite(&paths.display_dir, &entry, source_key)
        })
        .collect())
}

#[tauri::command]
fn load_display_gallery_summary(app: AppHandle) -> Result<serde_json::Value, String> {
    let paths = app_paths(&app)?;
    let index = read_index(&paths.display_index);
    let source_keys = index
        .iter()
        .map(display_entry_source_key)
        .collect::<Vec<_>>();
    Ok(json!({ "count": index.len(), "sourceKeys": source_keys }))
}

#[tauri::command]
fn archive_display_gallery(app: AppHandle) -> Result<serde_json::Value, String> {
    let paths = app_paths(&app)?;
    with_index_lock(&paths.display_dir, &paths.display_lock, || {
        let index = read_index(&paths.display_index);
        if index.is_empty() {
            return Ok(json!({ "archived": false, "count": 0 }));
        }

        let archive_dir = paths.display_archive_dir.join(archive_name());
        ensure_dir(&archive_dir)?;
        let mut count = 0;
        for entry in &index {
            let source = paths.display_dir.join(&entry.file);
            let target = archive_dir.join(&entry.file);
            if fs::rename(source, target).is_ok() {
                count += 1;
            }
        }
        fs::write(
            archive_dir.join("index.json"),
            serde_json::to_string(&index).unwrap_or_default(),
        )
        .map_err(|error| format!("Failed to write archive index: {error}"))?;
        write_index(&paths.display_index, &[])?;
        Ok(json!({ "archived": true, "count": count, "folder": archive_dir.to_string_lossy() }))
    })
}

#[tauri::command]
fn save_last_viewed_temp(app: AppHandle, payload: ImagePayload) -> Result<(), String> {
    let paths = app_paths(&app)?;
    let image = read_image_payload(&payload, &paths)?;
    let temp_path = paths.data_dir.join("last-viewed.png");
    fs::write(&temp_path, &image)
        .map_err(|error| format!("Failed to save last viewed image: {error}"))
}

#[tauri::command]
fn load_last_viewed_temp(app: AppHandle) -> Result<Option<String>, String> {
    let paths = app_paths(&app)?;
    let temp_path = paths.data_dir.join("last-viewed.png");
    if !temp_path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(&temp_path)
        .map_err(|error| format!("Failed to read last viewed image: {error}"))?;
    Ok(Some(bytes_to_data_url(&bytes)))
}

#[tauri::command]
fn start_image_drag(_payload: ImagePayload) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "windows")]
fn set_square_window_corners(window: &WebviewWindow, square: bool) -> Result<(), String> {
    let hwnd = window
        .hwnd()
        .map_err(|error| format!("Failed to read window handle: {error}"))?;
    let preference = if square {
        DWMWCP_DONOTROUND
    } else {
        DWMWCP_DEFAULT
    };
    let result = unsafe {
        DwmSetWindowAttribute(
            hwnd.0 as _,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            (&preference as *const u32).cast(),
            std::mem::size_of_val(&preference) as u32,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(format!("Failed to set window corner preference: {result}"))
    }
}

#[cfg(not(target_os = "windows"))]
fn set_square_window_corners(_window: &WebviewWindow, _square: bool) -> Result<(), String> {
    Ok(())
}

fn window_bounds(window: &WebviewWindow) -> Result<WindowBounds, String> {
    let position = window
        .outer_position()
        .map_err(|error| format!("Failed to read window position: {error}"))?;
    let size = window
        .inner_size()
        .map_err(|error| format!("Failed to read window size: {error}"))?;
    Ok(WindowBounds {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    })
}

fn restored_inner_size(window: &WebviewWindow, bounds: &WindowState) -> (u32, u32) {
    if bounds.size_kind.as_deref() == Some(WINDOW_SIZE_KIND_INNER) {
        return (bounds.width, bounds.height);
    }

    let Some((outer, inner)) = window.outer_size().ok().zip(window.inner_size().ok()) else {
        return (bounds.width, bounds.height);
    };

    let frame_width = outer.width.saturating_sub(inner.width);
    let frame_height = outer.height.saturating_sub(inner.height);
    (
        bounds.width.saturating_sub(frame_width).max(1),
        bounds.height.saturating_sub(frame_height).max(1),
    )
}

fn expand_borderless_edges(bounds: &WindowState) -> WindowState {
    let expand = u32::try_from(BORDERLESS_EDGE_EXPAND).unwrap_or(0);
    WindowState {
        x: bounds.x.saturating_sub(BORDERLESS_EDGE_EXPAND),
        y: bounds.y.saturating_sub(BORDERLESS_EDGE_EXPAND),
        width: bounds.width.saturating_add(expand.saturating_mul(2)),
        height: bounds.height.saturating_add(expand.saturating_mul(2)),
        size_kind: bounds.size_kind.clone(),
    }
}

fn shrink_borderless_edges(bounds: &WindowState) -> WindowState {
    let shrink = u32::try_from(BORDERLESS_EDGE_EXPAND).unwrap_or(0);
    WindowState {
        x: bounds.x.saturating_add(BORDERLESS_EDGE_EXPAND),
        y: bounds.y.saturating_add(BORDERLESS_EDGE_EXPAND),
        width: bounds.width.saturating_sub(shrink.saturating_mul(2)).max(1),
        height: bounds
            .height
            .saturating_sub(shrink.saturating_mul(2))
            .max(1),
        size_kind: bounds.size_kind.clone(),
    }
}

fn set_window_bounds(
    window: &WebviewWindow,
    bounds: &WindowState,
    expand_edges: bool,
) -> Result<(), String> {
    if bounds.width == 0 || bounds.height == 0 {
        return Ok(());
    }
    let adjusted;
    let bounds = if expand_edges {
        adjusted = expand_borderless_edges(bounds);
        &adjusted
    } else {
        bounds
    };
    let (width, height) = restored_inner_size(window, bounds);
    window
        .set_size(Size::Physical(PhysicalSize { width, height }))
        .map_err(|error| format!("Failed to restore window size: {error}"))?;
    window
        .set_position(Position::Physical(PhysicalPosition {
            x: bounds.x,
            y: bounds.y,
        }))
        .map_err(|error| format!("Failed to restore window position: {error}"))
}

#[tauri::command]
fn load_settings(app: AppHandle) -> Settings {
    load_settings_inner(&app)
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: Settings) -> Result<Settings, String> {
    save_settings_inner(&app, &settings)?;
    Ok(settings)
}

#[tauri::command]
fn save_window_state(app: AppHandle, window: WebviewWindow) -> Result<WindowBounds, String> {
    let bounds = window_bounds(&window)?;
    let mut settings = load_settings_inner(&app);
    let mut state = WindowState {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        size_kind: Some(WINDOW_SIZE_KIND_INNER.to_string()),
    };
    if settings.expand_borderless_edges {
        state = shrink_borderless_edges(&state);
    }
    settings.window = Some(state);
    save_settings_inner(&app, &settings)?;
    Ok(bounds)
}

#[tauri::command]
fn restore_window_state(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    let settings = load_settings_inner(&app);
    if !settings.remember_window_position {
        return Ok(());
    }
    if let Some(bounds) = settings.window {
        set_window_bounds(&window, &bounds, settings.expand_borderless_edges)?;
    }
    Ok(())
}

#[tauri::command]
fn set_window_square_corners(window: WebviewWindow, square: bool) -> Result<(), String> {
    set_square_window_corners(&window, square)
}

#[tauri::command]
fn adjust_window_borderless_edges(window: WebviewWindow, expand: bool) -> Result<(), String> {
    let bounds = window_bounds(&window)?;
    let bounds = WindowState {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        size_kind: Some(WINDOW_SIZE_KIND_INNER.to_string()),
    };
    let adjusted = if expand {
        expand_borderless_edges(&bounds)
    } else {
        shrink_borderless_edges(&bounds)
    };

    set_window_bounds(&window, &adjusted, false)
}

#[tauri::command]
fn window_minimize(window: WebviewWindow) -> Result<(), String> {
    window.minimize().map_err(|error| error.to_string())
}

#[tauri::command]
fn window_close(window: WebviewWindow) -> Result<(), String> {
    window.close().map_err(|error| error.to_string())
}

#[tauri::command]
fn window_maximize_toggle(window: WebviewWindow) -> Result<(), String> {
    if window.is_maximized().map_err(|error| error.to_string())? {
        window.unmaximize().map_err(|error| error.to_string())
    } else {
        window.maximize().map_err(|error| error.to_string())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            load_env_file(app.handle());
            if let Ok(paths) = app_paths(app.handle()) {
                let _ = ensure_dir(&paths.data_dir);
                let _ = ensure_dir(&paths.gallery_dir);
                let _ = ensure_dir(&paths.display_dir);
            }
            if let Some(window) = app.get_webview_window("main") {
                let settings = load_settings_inner(app.handle());
                let _ = set_square_window_corners(&window, settings.square_app_corners);
                if settings.remember_window_position {
                    if let Some(bounds) = settings.window {
                        let _ =
                            set_window_bounds(&window, &bounds, settings.expand_borderless_edges);
                    }
                }
            }
            Ok(())
        })
        .manage(AppState::default())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            adjust_window_borderless_edges,
            api_key_delete,
            api_key_save,
            api_key_status,
            archive_display_gallery,
            archive_gallery,
            cancel_generation,
            check_api_key,
            copy_image,
            generate_image,
            is_primary_instance,
            load_settings,
            load_display_gallery,
            load_display_gallery_summary,
            load_gallery,
            load_gallery_page,
            load_gallery_summary,
            load_last_viewed_temp,
            remove_from_display_gallery,
            restore_window_state,
            save_image,
            save_last_viewed_temp,
            save_settings,
            save_to_display_gallery,
            save_window_state,
            set_window_square_corners,
            start_image_drag,
            window_close,
            window_maximize_toggle,
            window_minimize
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
