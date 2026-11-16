//! アプリに同梱した CLI を、~/.local/bin/rootlore から使えるようにする。
//! 決まりは Hermes Desktop の cli-provision.ts と同じ:
//! - 空いていればリンクを張る（アプリを更新すると、リンク先の CLI も新しくなる）
//! - 手で入れた CLI（ふつうのファイル）や、生きているリンクには触らない
//! - 壊れたリンクは、同梱 CLI を指していたものだけ張り直す（アプリを移した・入れ直したとき）
use std::path::{Path, PathBuf};
use std::{fs, io};

const NAME: &str = "rootlore";
/// .app の中での名前。macOS のファイル名は大文字小文字を区別しないことが多く、本体の Rootlore とぶつかるので別名にする
const BUNDLED: &str = "rootlore-cli";

#[derive(Debug, PartialEq)]
pub enum Outcome {
    Linked,
    Repaired,
    Kept,
}

/// 同梱した CLI の場所。.app の中から起動したときだけ返す（cargo run では張らない）。
/// ダウンロードしたまま開いたとき（App Translocation の一時的な場所）も張らない。終了すると消える場所なので
pub fn bundled_cli() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    if exe.to_string_lossy().contains("/AppTranslocation/") {
        return None;
    }
    let dir = exe.parent()?;
    if !dir.ends_with("Contents/MacOS") {
        return None;
    }
    let cli = dir.join(BUNDLED);
    cli.is_file().then_some(cli)
}

pub fn provision(source: &Path, bin_dir: &Path) -> io::Result<Outcome> {
    fs::create_dir_all(bin_dir)?;
    let target = bin_dir.join(NAME);
    let meta = match fs::symlink_metadata(&target) {
        Ok(meta) => meta,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            std::os::unix::fs::symlink(source, &target)?;
            return Ok(Outcome::Linked);
        }
        Err(e) => return Err(e),
    };
    if !meta.file_type().is_symlink() || fs::metadata(&target).is_ok() {
        return Ok(Outcome::Kept);
    }
    if !is_bundle_link(&fs::read_link(&target)?) {
        return Ok(Outcome::Kept);
    }
    // 別名で張ってから置き換える。途中で失敗しても、rootlore が消えた状態にしない
    let staged = bin_dir.join(format!(".{NAME}.link-{}", std::process::id()));
    let _ = fs::remove_file(&staged);
    std::os::unix::fs::symlink(source, &staged)?;
    if let Err(e) = fs::rename(&staged, &target) {
        let _ = fs::remove_file(&staged);
        return Err(e);
    }
    Ok(Outcome::Repaired)
}

fn is_bundle_link(dest: &Path) -> bool {
    dest.is_absolute()
        && dest.file_name() == Some(BUNDLED.as_ref())
        && dest.parent().is_some_and(|dir| dir.ends_with("Contents/MacOS"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rootlore-cli-link-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn bundled(dir: &Path, app: &str) -> PathBuf {
        let cli = dir.join(app).join("Contents/MacOS").join(BUNDLED);
        fs::create_dir_all(cli.parent().unwrap()).unwrap();
        fs::write(&cli, "cli").unwrap();
        cli
    }

    #[test]
    fn links_when_empty() {
        let dir = temp("empty");
        let cli = bundled(&dir, "A.app");
        let bin = dir.join("bin");
        assert_eq!(provision(&cli, &bin).unwrap(), Outcome::Linked);
        assert_eq!(fs::read_link(bin.join(NAME)).unwrap(), cli);
        assert_eq!(provision(&cli, &bin).unwrap(), Outcome::Kept);
    }

    #[test]
    fn keeps_a_standalone_cli() {
        let dir = temp("file");
        let cli = bundled(&dir, "A.app");
        let bin = dir.join("bin");
        fs::create_dir_all(&bin).unwrap();
        fs::write(bin.join(NAME), "standalone").unwrap();
        assert_eq!(provision(&cli, &bin).unwrap(), Outcome::Kept);
        assert_eq!(fs::read_to_string(bin.join(NAME)).unwrap(), "standalone");
    }

    #[test]
    fn keeps_a_working_link_elsewhere() {
        let dir = temp("other");
        let cli = bundled(&dir, "A.app");
        let bin = dir.join("bin");
        fs::create_dir_all(&bin).unwrap();
        let other = dir.join("other-rootlore");
        fs::write(&other, "other").unwrap();
        std::os::unix::fs::symlink(&other, bin.join(NAME)).unwrap();
        assert_eq!(provision(&cli, &bin).unwrap(), Outcome::Kept);
        assert_eq!(fs::read_link(bin.join(NAME)).unwrap(), other);
    }

    #[test]
    fn repairs_only_broken_bundle_links() {
        let dir = temp("broken");
        let cli = bundled(&dir, "A.app");
        let bin = dir.join("bin");
        fs::create_dir_all(&bin).unwrap();
        let moved = dir.join("Old.app/Contents/MacOS").join(BUNDLED);
        std::os::unix::fs::symlink(&moved, bin.join(NAME)).unwrap();
        assert_eq!(provision(&cli, &bin).unwrap(), Outcome::Repaired);
        assert_eq!(fs::read_link(bin.join(NAME)).unwrap(), cli);

        fs::remove_file(bin.join(NAME)).unwrap();
        let gone = dir.join("somewhere/rootlore");
        std::os::unix::fs::symlink(&gone, bin.join(NAME)).unwrap();
        assert_eq!(provision(&cli, &bin).unwrap(), Outcome::Kept);
        assert_eq!(fs::read_link(bin.join(NAME)).unwrap(), gone);
    }
}
