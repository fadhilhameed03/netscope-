//! Native embedded browser (Linux only).
//!
//! Tauri's JS-level multiwebview API (`new Webview(...)`, `setPosition`,
//! `setSize`) places child webviews inside `default_vbox()` — a plain
//! `gtk::Box`. A `Box` has no concept of absolute x/y placement, only
//! linear stacking order, so every child webview ends up positioned
//! *after* existing content regardless of what setPosition/setSize claim
//! to do (tauri-apps/tauri#13071, duplicate of #10420).
//!
//! This module sidesteps that entirely: it wraps the window's existing
//! content in a `gtk::Overlay`, layers a `gtk::Fixed` on top of it (the
//! actual GTK primitive for absolute pixel positioning), and drives a
//! `webkit2gtk::WebView` placed inside that `Fixed` directly. This also
//! gives real back/forward/reload support, since we're driving the
//! WebKit engine ourselves instead of going through wry's wrapper.

use serde::Serialize;
use std::cell::RefCell;
use tauri::{AppHandle, Emitter, Runtime, WebviewWindow};
use webkit2gtk::{LoadEvent, WebView, WebViewExt};

thread_local! {
    // GTK objects are not Send/Sync — they must only ever be touched on
    // the GTK main thread. Every command below reaches this via
    // `window.run_on_main_thread`, which guarantees that, so thread-local
    // storage is the correct (and simplest) place to keep them.
    static STATE: RefCell<Option<BrowserWidgets>> = RefCell::new(None);
}

struct BrowserWidgets {
    fixed: gtk::Fixed,
    webview: WebView,
}

#[derive(Serialize, Clone)]
pub struct NativeBrowserState {
    pub url: String,
    pub title: Option<String>,
    pub loading: bool,
    pub can_go_back: bool,
    pub can_go_forward: bool,
}

fn emit_state<R: Runtime>(app: &AppHandle<R>, webview: &WebView, loading: bool) {
    let state = NativeBrowserState {
        url: webview.uri().map(|u| u.to_string()).unwrap_or_default(),
        title: webview.title().map(|t| t.to_string()),
        loading,
        can_go_back: webview.can_go_back(),
        can_go_forward: webview.can_go_forward(),
    };
    let _ = app.emit("native-browser-state", state);
}

/// Wraps the window's existing content in a gtk::Overlay (idempotent —
/// only does this once) and ensures a WebView + Fixed exist, creating them
/// on first use. Must be called from the GTK main thread.
fn ensure_widgets<R: Runtime>(window: &WebviewWindow<R>, app: &AppHandle<R>) -> Result<(), String> {
    let already_set_up = STATE.with(|s| s.borrow().is_some());
    if already_set_up {
        return Ok(());
    }

    use gtk::prelude::*;

    let vbox = window
        .default_vbox()
        .map_err(|e| format!("Could not get window's default vbox: {e}"))?;

    let children = vbox.children();
    let main_widget = children
        .first()
        .ok_or_else(|| "Window vbox has no existing child to wrap".to_string())?
        .clone();

    let overlay = gtk::Overlay::new();
    vbox.remove(&main_widget);
    overlay.add(&main_widget);
    vbox.pack_start(&overlay, true, true, 0);

    let fixed = gtk::Fixed::new();
    // The Fixed itself must fill the overlay's full area for its children's
    // (x, y) coordinates to line up with real window-relative pixels.
    fixed.set_halign(gtk::Align::Fill);
    fixed.set_valign(gtk::Align::Fill);
    overlay.add_overlay(&fixed);
    overlay.set_overlay_pass_through(&fixed, true);

    let webview = WebView::new();
    fixed.put(&webview, 0, 0);

    let app_clone = app.clone();
    webview.connect_load_changed(move |wv, event| {
        let loading = !matches!(event, LoadEvent::Finished);
        emit_state(&app_clone, wv, loading);
    });
    let app_clone2 = app.clone();
    webview.connect_title_notify(move |wv| {
        emit_state(&app_clone2, wv, wv.is_loading());
    });

    overlay.show_all();
    fixed.show();
    webview.show();

    STATE.with(|s| {
        *s.borrow_mut() = Some(BrowserWidgets { fixed, webview });
    });

    Ok(())
}

pub fn navigate<R: Runtime>(
    window: WebviewWindow<R>,
    app: AppHandle<R>,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let (tx, rx) = std::sync::mpsc::channel();
    let window_for_thread = window.clone();
    window
        .run_on_main_thread(move || {
            let result = (|| -> Result<(), String> {
                ensure_widgets(&window_for_thread, &app)?;
                use gtk::prelude::*;
                STATE.with(|s| {
                    let borrow = s.borrow();
                    let widgets = borrow.as_ref().ok_or("browser widgets not initialized")?;
                    widgets.fixed.move_(&widgets.webview, x.round() as i32, y.round() as i32);
                    widgets
                        .webview
                        .set_size_request(width.round() as i32, height.round() as i32);
                    widgets.webview.load_uri(&url);
                    widgets.webview.show();
                    Ok(())
                })
            })();
            let _ = tx.send(result);
        })
        .map_err(|e| format!("run_on_main_thread failed: {e}"))?;
    rx.recv().map_err(|e| format!("channel error: {e}"))?
}

pub fn set_bounds<R: Runtime>(
    window: WebviewWindow<R>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let (tx, rx) = std::sync::mpsc::channel();
    window
        .run_on_main_thread(move || {
            let result = STATE.with(|s| {
                use gtk::prelude::*;
                let borrow = s.borrow();
                match borrow.as_ref() {
                    Some(widgets) => {
                        widgets.fixed.move_(&widgets.webview, x.round() as i32, y.round() as i32);
                        widgets
                            .webview
                            .set_size_request(width.round() as i32, height.round() as i32);
                        Ok(())
                    }
                    None => Ok(()), // not created yet — nothing to resize
                }
            });
            let _ = tx.send(result);
        })
        .map_err(|e| format!("run_on_main_thread failed: {e}"))?;
    rx.recv().map_err(|e| format!("channel error: {e}"))?
}

pub fn set_visible<R: Runtime>(window: WebviewWindow<R>, visible: bool) -> Result<(), String> {
    let (tx, rx) = std::sync::mpsc::channel();
    window
        .run_on_main_thread(move || {
            let result = STATE.with(|s| {
                use gtk::prelude::*;
                let borrow = s.borrow();
                if let Some(widgets) = borrow.as_ref() {
                    if visible {
                        widgets.webview.show();
                    } else {
                        widgets.webview.hide();
                    }
                }
                Ok(())
            });
            let _ = tx.send(result);
        })
        .map_err(|e| format!("run_on_main_thread failed: {e}"))?;
    rx.recv().map_err(|e: std::sync::mpsc::RecvError| format!("channel error: {e}"))?
}

fn simple_action<R: Runtime>(
    window: WebviewWindow<R>,
    action: impl FnOnce(&WebView) + Send + 'static,
) -> Result<(), String> {
    let (tx, rx) = std::sync::mpsc::channel();
    window
        .run_on_main_thread(move || {
            let result = STATE.with(|s| {
                let borrow = s.borrow();
                if let Some(widgets) = borrow.as_ref() {
                    action(&widgets.webview);
                }
                Ok(())
            });
            let _ = tx.send(result);
        })
        .map_err(|e| format!("run_on_main_thread failed: {e}"))?;
    rx.recv().map_err(|e| format!("channel error: {e}"))?
}

pub fn go_back<R: Runtime>(window: WebviewWindow<R>) -> Result<(), String> {
    simple_action(window, |wv| wv.go_back())
}

pub fn go_forward<R: Runtime>(window: WebviewWindow<R>) -> Result<(), String> {
    simple_action(window, |wv| wv.go_forward())
}

pub fn refresh<R: Runtime>(window: WebviewWindow<R>) -> Result<(), String> {
    simple_action(window, |wv| wv.reload())
}