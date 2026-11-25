//! ノートの front matter（先頭の --- 〜 ---）を読み、一部のキーだけを書き換える。
//! YAML 全体ではなく、一番上の段のキーと、文字列・文字列の一覧だけを扱う。書き換えは行の差し替えで行い、
//! 触らない行（本文、ほかのキー、コメント）は1バイトも変えない。安全に直せない書き方は、直さずにエラーにする。

#[derive(Debug, PartialEq)]
pub enum Value {
    /// 値がない（`key:`、`key: null`、`key: ~`）
    Empty,
    Text(String),
    List(Vec<String>),
    /// ここでは読めない書き方（入れ子、複数行の [ ] など）
    Other,
}

/// 一番上の段のキー1つ。行番号は split_inclusive('\n') の並びで数える
struct Entry {
    key: String,
    start: usize,
    /// 値の最後の行の次（後ろに続く空行やコメントは含まない）
    end: usize,
    value: Value,
}

pub struct FrontMatter<'a> {
    lines: Vec<&'a str>,
    /// 閉じの --- の行
    close: usize,
    entries: Vec<Entry>,
}

fn bare(line: &str) -> &str {
    line.trim_end_matches(['\n', '\r'])
}

/// 行が一番上の段の「キー:」なら、キーと、その後ろ
fn key_of(line: &str) -> Option<(&str, &str)> {
    if line.starts_with([' ', '\t', '#', '-', '[', '{']) {
        return None;
    }
    let (key, rest) = line.split_once(':')?;
    // "repos": のような引用符付きのキーも同じキー（見落とすと、同じキーを二重に足してしまう）
    (rest.is_empty() || rest.starts_with([' ', '\t'])).then(|| (key.trim_end().trim_matches(['"', '\'']), rest.trim()))
}

/// 「- 値」の行なら、値
fn item_of(line: &str) -> Option<&str> {
    let rest = line.trim_start().strip_prefix('-')?;
    (rest.is_empty() || rest.starts_with([' ', '\t'])).then(|| rest.trim())
}

/// 1行の値を読む。引用符を外し、後ろのコメントを落とす。後ろに残った長さ（コメント）も返す
fn scalar(raw: &str) -> Option<(String, &str)> {
    let raw = raw.trim();
    let after = |rest: &str| rest.trim().is_empty() || (rest.starts_with([' ', '\t']) && rest.trim_start().starts_with('#'));
    if let Some(body) = raw.strip_prefix('"') {
        let mut out = String::new();
        let mut chars = body.char_indices();
        while let Some((i, c)) = chars.next() {
            match c {
                '"' => return after(&body[i + 1..]).then(|| (out, &body[i + 1..])),
                '\\' => match chars.next()?.1 {
                    'n' => out.push('\n'),
                    't' => out.push('\t'),
                    c @ ('"' | '\\' | '/') => out.push(c),
                    _ => return None,
                },
                c => out.push(c),
            }
        }
        return None;
    }
    if let Some(body) = raw.strip_prefix('\'') {
        let mut out = String::new();
        let mut chars = body.char_indices().peekable();
        while let Some((i, c)) = chars.next() {
            if c != '\'' {
                out.push(c);
            } else if chars.next_if(|(_, c)| *c == '\'').is_some() {
                out.push('\'');
            } else {
                return after(&body[i + 1..]).then(|| (out, &body[i + 1..]));
            }
        }
        return None;
    }
    if raw.starts_with(['[', '{', '&', '*', '!', '|', '>', '%', '@', '`']) {
        return None;
    }
    if raw.starts_with('#') {
        return Some((String::new(), raw));
    }
    let cut = raw.find(" #").into_iter().chain(raw.find("\t#")).min().unwrap_or(raw.len());
    Some((raw[..cut].trim_end().to_string(), &raw[cut..]))
}

/// 1行の [a, "b, c"] を読む。閉じの ] の位置も返す
fn flow_list(raw: &str) -> Option<(Vec<String>, usize)> {
    let body = raw.strip_prefix('[')?;
    let (mut items, mut start, mut quote, mut escaped) = (vec![], 0, None, false);
    for (i, c) in body.char_indices() {
        if let Some(q) = quote {
            if escaped {
                escaped = false;
            } else if c == '\\' && q == '"' {
                escaped = true;
            } else if c == q {
                quote = None;
            }
            continue;
        }
        match c {
            '"' | '\'' if body[start..i].trim().is_empty() => quote = Some(c),
            '[' | '{' => return None,
            ',' | ']' => {
                let part = body[start..i].trim();
                if !part.is_empty() {
                    let (text, rest) = scalar(part)?;
                    if !rest.is_empty() {
                        return None;
                    }
                    items.push(text);
                } else if c == ',' {
                    return None;
                }
                if c == ']' {
                    let tail = body[i + 1..].trim_start();
                    return (tail.is_empty() || tail.starts_with('#')).then_some((items, i + 1));
                }
                start = i + 1;
            }
            _ => {}
        }
    }
    None
}

fn value_of(first: &str, more: &[&str]) -> Value {
    // 空行とコメントを除いた、続きの行
    let rest: Vec<&str> = more.iter().map(|l| bare(l)).filter(|l| !l.trim().is_empty() && !l.trim_start().starts_with('#')).collect();
    if first.starts_with(['|', '>']) {
        let joiner = if first.starts_with('|') { "\n" } else { " " };
        return Value::Text(more.iter().map(|l| bare(l).trim()).collect::<Vec<_>>().join(joiner).trim().to_string());
    }
    if first.is_empty() || first.starts_with('#') {
        if rest.is_empty() {
            return Value::Empty;
        }
        // 同じ字下げの「- 値」だけを、一覧として読む
        let indent = |l: &str| l.len() - l.trim_start().len();
        let items: Option<Vec<String>> = rest
            .iter()
            .map(|l| {
                let item = item_of(l).filter(|_| indent(l) == indent(rest[0]))?;
                let (text, _) = scalar(item)?;
                // 「- name: x」は入れ子
                let nested = !item.starts_with(['"', '\'']) && (text.contains(": ") || text.ends_with(':'));
                (!nested && !text.is_empty()).then_some(text)
            })
            .collect();
        return items.map_or(Value::Other, Value::List);
    }
    if !rest.is_empty() {
        // 折り返した文字列は、1行につなぐ（引用符のあるものは読まない）
        if first.starts_with(['"', '\'', '[', '{']) {
            return Value::Other;
        }
        let joined = std::iter::once(first).chain(rest.iter().map(|l| l.trim())).collect::<Vec<_>>().join(" ");
        return Value::Text(joined);
    }
    if first.starts_with('[') {
        return flow_list(first).map_or(Value::Other, |(items, _)| Value::List(items));
    }
    match scalar(first) {
        Some((text, _)) if !first.starts_with(['"', '\'']) && matches!(text.as_str(), "" | "~" | "null" | "Null" | "NULL") => Value::Empty,
        Some((text, _)) => Value::Text(text),
        None => Value::Other,
    }
}

impl<'a> FrontMatter<'a> {
    pub fn parse(text: &'a str) -> Option<FrontMatter<'a>> {
        let lines: Vec<&str> = text.split_inclusive('\n').collect();
        if bare(lines.first()?.trim_start_matches('\u{feff}')).trim_end() != "---" {
            return None;
        }
        let close = 1 + lines[1..].iter().position(|l| matches!(bare(l).trim_end(), "---" | "..."))?;
        let mut entries = vec![];
        let mut i = 1;
        while i < close {
            let Some((key, first)) = key_of(bare(lines[i])) else {
                i += 1;
                continue;
            };
            let start = i;
            let mut end = i + 1;
            i += 1;
            while i < close && key_of(bare(lines[i])).is_none() {
                let line = bare(lines[i]);
                let continues = line.starts_with([' ', '\t']) || item_of(line).is_some();
                if continues && !line.trim().is_empty() && !line.trim_start().starts_with('#') {
                    end = i + 1;
                } else if !continues && !line.trim().is_empty() && !line.starts_with('#') {
                    break;
                }
                i += 1;
            }
            let value = value_of(first, &lines[start + 1..end]);
            entries.push(Entry { key: key.to_string(), start, end, value });
        }
        Some(FrontMatter { lines, close, entries })
    }

    fn entry(&self, key: &str) -> Option<&Entry> {
        self.entries.iter().find(|e| e.key == key)
    }

    pub fn text(&self, key: &str) -> Option<&str> {
        match &self.entry(key)?.value {
            Value::Text(t) if !t.is_empty() => Some(t),
            _ => None,
        }
    }

    /// 一覧。文字列1つだけの書き方は、1件の一覧として読む
    pub fn list(&self, key: &str) -> Vec<String> {
        match self.entry(key).map(|e| &e.value) {
            Some(Value::List(items)) => items.clone(),
            Some(Value::Text(t)) if !t.is_empty() => vec![t.clone()],
            _ => vec![],
        }
    }

    fn newline(&self) -> &'static str {
        if self.lines[0].ends_with("\r\n") {
            "\r\n"
        } else {
            "\n"
        }
    }

    /// 行 [from, to) を new に差し替えた全文
    fn splice(&self, from: usize, to: usize, new: &str) -> String {
        format!("{}{new}{}", self.lines[..from].concat(), self.lines[to..].concat())
    }

    /// key の値を文字列1つにする（なければ足す）
    pub fn set_text(&self, key: &str, value: &str) -> Result<String, ()> {
        let line = format!("{key}: {}{}", quote(value), self.newline());
        match self.entry(key) {
            None => Ok(self.splice(self.close, self.close, &line)),
            Some(e) if matches!(e.value, Value::Text(_) | Value::Empty) => Ok(self.splice(e.start, e.end, &line)),
            Some(_) => Err(()),
        }
    }

    /// key の一覧の末尾に item を足す（なければ作る）
    pub fn push_item(&self, key: &str, item: &str) -> Result<String, ()> {
        let nl = self.newline();
        let block = |items: &[&str]| {
            let lines: String = items.iter().map(|i| format!("  - {}{nl}", quote(i))).collect();
            format!("{key}:{nl}{lines}")
        };
        let Some(e) = self.entry(key) else {
            return Ok(self.splice(self.close, self.close, &block(&[item])));
        };
        let first = bare(self.lines[e.start]);
        let after_key = key_of(first).map_or("", |(_, rest)| rest);
        match &e.value {
            Value::Empty => Ok(self.splice(e.start, e.end, &block(&[item]))),
            Value::Text(t) if e.end == e.start + 1 && !after_key.starts_with(['|', '>']) => {
                Ok(self.splice(e.start, e.end, &block(&[t, item])))
            }
            Value::List(items) if after_key.starts_with('[') => {
                let open = first.find('[').ok_or(())?;
                let (_, len) = flow_list(&first[open..]).ok_or(())?;
                let close = open + len;
                let head = first[..close].trim_end();
                let comma = if items.is_empty() || head.ends_with(',') { "" } else { "," };
                let space = if items.is_empty() { "" } else { " " };
                let line = &self.lines[e.start];
                let new = format!("{head}{comma}{space}{}{}", quote(item), &line[close..]);
                Ok(self.splice(e.start, e.end, &new))
            }
            Value::List(_) => {
                // 最後の項目と同じ字下げで、そのすぐ下に足す
                let last = bare(self.lines[e.end - 1]);
                let indent = &last[..last.len() - last.trim_start().len()];
                Ok(self.splice(e.end, e.end, &format!("{indent}- {}{nl}", quote(item))))
            }
            _ => Err(()),
        }
    }
}

/// 値を YAML の1行の文字列にする。そのまま書けないものだけ "…" で囲む
pub fn quote(value: &str) -> String {
    let plain = !value.is_empty()
        && value.trim() == value
        && !value.starts_with(['-', '?', ':', ',', '[', ']', '{', '}', '#', '&', '*', '!', '|', '>', '\'', '"', '%', '@', '`', '~'])
        && !value.contains(": ")
        && !value.contains(" #")
        && !value.ends_with(':')
        && !value.contains([',', '[', ']', '{', '}'])
        && !value.chars().any(char::is_control)
        && !["null", "true", "false", "yes", "no", "on", "off"].iter().any(|w| value.eq_ignore_ascii_case(w))
        && value.parse::<f64>().is_err();
    if plain {
        value.to_string()
    } else {
        format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BODY: &str = "\n# Alpha  \r\n\n---\nrepos: not-front-matter\n\ttab\n末尾の改行なし";

    fn note(head: &str) -> String {
        format!("---\n{head}---\n{BODY}")
    }

    fn pushed(head: &str, item: &str) -> String {
        FrontMatter::parse(&note(head)).unwrap().push_item("repos", item).unwrap()
    }

    #[test]
    fn reads_the_project_keys() {
        let text = note(
            "type: project # kind\nrepos:\n  - acme/app\n  # old\n  - 'acme/web' # site\n\nsite: https://example.com/#top\ndrive: \"https://drive.example.com/a?x=1&y=\\\"2\\\"\"\nrelease: >\n  Tag and push,\n  then wait.\npeople: [Ann, \"Lee, Bo\"]\n",
        );
        let fm = FrontMatter::parse(&text).unwrap();
        assert_eq!(fm.text("type"), Some("project"));
        assert_eq!(fm.list("repos"), ["acme/app", "acme/web"]);
        assert_eq!(fm.text("site"), Some("https://example.com/#top"));
        assert_eq!(fm.text("drive"), Some("https://drive.example.com/a?x=1&y=\"2\""));
        assert_eq!(fm.text("release"), Some("Tag and push, then wait."));
        assert_eq!(fm.list("people"), ["Ann", "Lee, Bo"]);
        assert_eq!(fm.text("missing"), None);
    }

    #[test]
    fn notes_without_front_matter_are_not_parsed() {
        for text in ["", "# a\n", "---\ntype: project\n", " ---\na: 1\n---\n"] {
            assert!(FrontMatter::parse(text).is_none(), "{text:?}");
        }
    }

    #[test]
    fn adding_a_repo_changes_only_that_key() {
        for (before, after) in [
            ("type: project\n", "type: project\nrepos:\n  - a/new\n"),
            ("repos:\ntype: project\n", "repos:\n  - a/new\ntype: project\n"),
            ("repos: []\n", "repos: [a/new]\n"),
            ("repos: [a/old] # mine\nx: 1\n", "repos: [a/old, a/new] # mine\nx: 1\n"),
            ("repos: a/old\n", "repos:\n  - a/old\n  - a/new\n"),
            ("repos:\n- a/old\n\n# next\nx: 1\n", "repos:\n- a/old\n- a/new\n\n# next\nx: 1\n"),
            ("repos:\n    - a/old\n", "repos:\n    - a/old\n    - a/new\n"),
            ("\"repos\":\n  - a/old\n", "\"repos\":\n  - a/old\n  - a/new\n"),
        ] {
            assert_eq!(pushed(before, "a/new"), note(after), "{before:?}");
        }
    }

    #[test]
    fn setting_a_link_replaces_or_adds_one_line() {
        let text = note("site: https://old.example.com\nx: 1\n");
        let fm = FrontMatter::parse(&text).unwrap();
        assert_eq!(fm.set_text("site", "https://new.example.com").unwrap(), note("site: https://new.example.com\nx: 1\n"));
        assert_eq!(fm.set_text("drive", "https://d.example.com").unwrap(), note("site: https://old.example.com\nx: 1\ndrive: https://d.example.com\n"));
    }

    #[test]
    fn crlf_and_bom_are_kept() {
        let text = "\u{feff}---\r\ntype: project\r\n---\r\nbody\r\n";
        let fm = FrontMatter::parse(text).unwrap();
        assert_eq!(fm.push_item("repos", "a/b").unwrap(), "\u{feff}---\r\ntype: project\r\nrepos:\r\n  - a/b\r\n---\r\nbody\r\n");
    }

    #[test]
    fn shapes_that_cannot_be_edited_safely_are_refused() {
        for head in ["repos:\n  - name: x\n    url: y\n", "repos: [a/b,\n  c/d]\n", "repos: &r\n  - a/b\n", "repos: |\n  a/b\n", "repos: {a: b}\n"] {
            let text = note(head);
            assert!(FrontMatter::parse(&text).unwrap().push_item("repos", "a/new").is_err(), "{head:?}");
        }
        let text = note("site:\n  - a\n");
        assert!(FrontMatter::parse(&text).unwrap().set_text("site", "b").is_err());
    }

    #[test]
    fn written_values_read_back_the_same() {
        for value in ["plain", "https://e.com/a?b=1#c", "a: b", "x #y", "[x]", "a,b", "true", "42", "\"q\" \\ z", " pad ", "-dash", "end:"] {
            let text = format!("---\nk: {}\nl: [{}]\n---\n", quote(value), quote(value));
            let fm = FrontMatter::parse(&text).unwrap();
            assert_eq!(fm.text("k"), Some(value), "{text}");
            assert_eq!(fm.list("l"), [value], "{text}");
        }
    }
}
