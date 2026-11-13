// Rootlore のデスクトップ版: 手元専用（127.0.0.1）の MCP の入口（Streamable HTTP の、JSON で答える最小の形）。
// 道具を呼ばれたら、窓の中の Rootlore（mcp.js の window.__vwMcp）に頼んで、答えを mcp_result で受け取る。
// 起動ごとに鍵を作り、鍵のない要求と、ブラウザのページからの要求（Origin が付く）は断る。
use std::collections::HashMap;
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

pub const PORT: u16 = 37421;

#[derive(Default)]
pub struct McpState {
    waiting: Mutex<HashMap<u64, mpsc::Sender<(bool, String)>>>,
    next: Mutex<u64>,
}

#[tauri::command]
pub fn mcp_result(state: tauri::State<McpState>, id: u64, ok: bool, payload: String) {
    if let Some(tx) = state.waiting.lock().unwrap().remove(&id) {
        let _ = tx.send((ok, payload));
    }
}

fn tools_list() -> Value {
    json!([
      {"name":"search_notes","description":"Rootlore の Vault（GitHub が正本の Markdown ノート）を、言葉で探す。名前と本文の両方を見て、当たった行を返す。言い換えて何度か探すとよい。",
       "inputSchema":{"type":"object","properties":{"query":{"type":"string","description":"探す言葉。空白で区切ると全部を含むノート"},"limit":{"type":"number"},"prefix":{"type":"string","description":"フォルダで絞る（例: 0_AgentBrain/）"}},"required":["query"]}},
      {"name":"read_note","description":"ノートを読む。path は Vault の中の場所（例: 0_AgentBrain/INDEX.md）。",
       "inputSchema":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]},"annotations":{"readOnlyHint":true,"openWorldHint":false}},
      {"name":"list_notes","description":"ノートの場所の一覧。prefix でフォルダを絞る。",
       "inputSchema":{"type":"object","properties":{"prefix":{"type":"string"},"limit":{"type":"number"}}},"annotations":{"readOnlyHint":true,"openWorldHint":false}}
    ])
}

fn call_tool(app: &AppHandle, name: &str, args: &Value) -> Result<String, String> {
    let state = app.state::<McpState>();
    let id = {
        let mut n = state.next.lock().unwrap();
        *n += 1;
        *n
    };
    let (tx, rx) = mpsc::channel();
    state.waiting.lock().unwrap().insert(id, tx);
    let window = app.get_webview_window("main").ok_or("アプリの窓がありません")?;
    let script = format!(
        "window.__vwMcp ? window.__vwMcp.handle({id}, {}, {}) : window.__TAURI_INTERNALS__.invoke('mcp_result', {{id: {id}, ok: false, payload: 'Rootlore がまだ開いていません'}})",
        serde_json::to_string(name).unwrap(),
        serde_json::to_string(&args.to_string()).unwrap()
    );
    window.eval(&script).map_err(|e| e.to_string())?;
    let result = rx.recv_timeout(Duration::from_secs(60));
    state.waiting.lock().unwrap().remove(&id);
    match result {
        Ok((true, payload)) => Ok(payload),
        Ok((false, message)) => Err(message),
        Err(_) => Err("Rootlore から60秒以内に答えがありませんでした".into()),
    }
}

fn handle_rpc(app: &AppHandle, req: &Value) -> Option<Value> {
    let id = req.get("id").cloned();
    let method = req.get("method").and_then(Value::as_str).unwrap_or("");
    let result = match method {
        "initialize" => json!({
            "protocolVersion": req.pointer("/params/protocolVersion").and_then(Value::as_str).unwrap_or("2025-03-26"),
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "rootlore", "version": "0.0.1"}
        }),
        "ping" => json!({}),
        "tools/list" => json!({"tools": tools_list()}),
        "tools/call" => {
            let name = req.pointer("/params/name").and_then(Value::as_str).unwrap_or("");
            let args = req.pointer("/params/arguments").cloned().unwrap_or(json!({}));
            match call_tool(app, name, &args) {
                Ok(text) => json!({"content":[{"type":"text","text":text}]}),
                Err(e) => json!({"content":[{"type":"text","text":e}],"isError":true}),
            }
        }
        _ if id.is_none() => return None, // 通知（notifications/initialized など）には答えない
        _ => return Some(json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"method not found"}})),
    };
    Some(json!({"jsonrpc":"2.0","id":id,"result":result}))
}

pub fn start(app: AppHandle, token: String) {
    std::thread::spawn(move || {
        let server = match tiny_http::Server::http(("127.0.0.1", PORT)) {
            Ok(s) => s,
            Err(e) => {
                crate::log(&format!(r#"{{"stage":"mcp-error","error":{:?}}}"#, e.to_string()));
                return;
            }
        };
        for mut request in server.incoming_requests() {
            let header = |name: &str| {
                request
                    .headers()
                    .iter()
                    .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name))
                    .map(|h| h.value.as_str().to_string())
            };
            let authorized = header("Authorization").as_deref() == Some(&format!("Bearer {token}"));
            let from_page = header("Origin").is_some();
            let host_ok = header("Host").map_or(false, |h| h == format!("127.0.0.1:{PORT}") || h == format!("localhost:{PORT}"));
            if request.url() != "/mcp" {
                let _ = request.respond(tiny_http::Response::empty(404));
                continue;
            }
            if !authorized || from_page || !host_ok {
                let _ = request.respond(tiny_http::Response::empty(403));
                continue;
            }
            if request.method() != &tiny_http::Method::Post {
                let _ = request.respond(tiny_http::Response::empty(405));
                continue;
            }
            let mut body = String::new();
            let _ = request.as_reader().read_to_string(&mut body);
            let app = app.clone();
            std::thread::spawn(move || {
                let reply = serde_json::from_str::<Value>(&body)
                    .ok()
                    .and_then(|req| handle_rpc(&app, &req));
                let json_header = tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap();
                let response = match reply {
                    Some(v) => tiny_http::Response::from_string(v.to_string()).with_header(json_header),
                    None => tiny_http::Response::from_string("").with_status_code(202),
                };
                let _ = request.respond(response);
            });
        }
    });
}
