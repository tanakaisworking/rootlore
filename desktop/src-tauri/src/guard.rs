//! 壊れない入口。OS（メニュー、ディープリンク、終了）や画面（コマンド、ページの移動）から呼ばれる処理は、ここを通して動かす。
//! 中で panic しても、アプリ全体は止めずにログに残して続ける。Objective-C から呼ばれる所で panic すると、
//! macOS がアプリごと止める（GitHub でつないだ直後に落ちていた、2026-11-17）。
//! 落ちうる処理（通信など）は別スレッドで動かし、その中もこの run で包む。
use std::any::Any;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Mutex, MutexGuard};

/// f を動かす。panic したら、どこで何が起きたかをログに残して None を返す
pub fn run<T>(name: &str, f: impl FnOnce() -> T) -> Option<T> {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(value) => Some(value),
        Err(error) => {
            crate::log(
                &serde_json::json!({ "stage": "recovered-panic", "at": name, "message": message(error.as_ref()) }).to_string(),
            );
            None
        }
    }
}

/// 落ちうる処理を別スレッドで動かす（画面のスレッドを止めない。中で panic してもそのスレッドだけで終わる）
pub fn spawn(name: &'static str, f: impl FnOnce() + Send + 'static) {
    std::thread::spawn(move || {
        run(name, f);
    });
}

/// ほかの所が持ったまま panic した Mutex でも、中身を使って続ける（1か所の失敗で、触る所が次々に止まらないように）
pub fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// panic の中身と場所を、画面に出ないログに残す（以前は何も残らず、原因が分からなかった）
pub fn install_panic_log() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info.location().map(|l| format!("{}:{}", l.file(), l.line())).unwrap_or_default();
        crate::log(
            &serde_json::json!({ "stage": "panic", "message": message(info.payload()), "location": location }).to_string(),
        );
        default(info);
    }));
}

fn message(payload: &(dyn Any + Send)) -> String {
    if let Some(text) = payload.downcast_ref::<&str>() {
        text.to_string()
    } else if let Some(text) = payload.downcast_ref::<String>() {
        text.clone()
    } else {
        "unknown".into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_panic_is_contained_and_returns_none() {
        assert_eq!(run("test", || 1 + 1), Some(2));
        assert_eq!(run("test", || -> i32 { panic!("boom") }), None);
    }

    #[test]
    fn a_poisoned_lock_still_gives_its_value() {
        let shared = std::sync::Arc::new(Mutex::new(5));
        let held = shared.clone();
        let _ = std::thread::spawn(move || {
            let _guard = held.lock().unwrap();
            panic!("poison it");
        })
        .join();
        assert!(shared.lock().is_err());
        *lock(&shared) += 1;
        assert_eq!(*lock(&shared), 6);
    }
}
