//! Markdown → sanitized HTML.
//!
//! * GitHub-flavoured Markdown (tables, task lists, footnotes, strikethrough,
//!   alerts, definition lists, heading attributes).
//! * Every heading gets a stable, Unicode-aware slug id (Hebrew included) so
//!   that `[link](#כותרת)` style anchors and the table of contents work.
//! * Fenced code is syntax-highlighted with syntect (CSS classes, so it follows
//!   the light/dark theme).
//! * The final HTML is sanitized with ammonia: raw HTML in a Markdown file can
//!   never run scripts inside the reader.

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use pulldown_cmark::{CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd, html};
use syntect::html::{ClassStyle, ClassedHTMLGenerator, css_for_theme_with_class_style};
use syntect::parsing::SyntaxSet;
use syntect::util::LinesWithEndings;

const CLASS_STYLE: ClassStyle = ClassStyle::SpacedPrefixed { prefix: "hl-" };

pub struct Rendered {
    pub html: String,
    /// Text of the first H1 (used for the window title), if any.
    pub title: Option<String>,
    pub words: usize,
    /// The document contains LaTeX math (`$…$`, `$$…$$`, ```math).
    pub has_math: bool,
    /// The document contains ```mermaid diagrams.
    pub has_mermaid: bool,
    /// The document contains ```dot / ```graphviz graphs.
    pub has_graphviz: bool,
}

fn syntax_set() -> &'static SyntaxSet {
    static SET: OnceLock<SyntaxSet> = OnceLock::new();
    SET.get_or_init(SyntaxSet::load_defaults_newlines)
}

/// Warm the syntax set on a background thread so the first code block is instant.
pub fn prewarm() {
    std::thread::spawn(|| {
        let _ = syntax_set();
    });
}

pub fn render(src: &str) -> Rendered {
    let src = src.strip_prefix('\u{feff}').unwrap_or(src);

    let mut opts = Options::empty();
    opts.insert(Options::ENABLE_TABLES);
    opts.insert(Options::ENABLE_FOOTNOTES);
    opts.insert(Options::ENABLE_STRIKETHROUGH);
    opts.insert(Options::ENABLE_TASKLISTS);
    opts.insert(Options::ENABLE_HEADING_ATTRIBUTES);
    opts.insert(Options::ENABLE_YAML_STYLE_METADATA_BLOCKS);
    opts.insert(Options::ENABLE_PLUSES_DELIMITED_METADATA_BLOCKS);
    opts.insert(Options::ENABLE_GFM);
    opts.insert(Options::ENABLE_DEFINITION_LIST);
    opts.insert(Options::ENABLE_SUPERSCRIPT);
    opts.insert(Options::ENABLE_SUBSCRIPT);
    opts.insert(Options::ENABLE_MATH);
    // NOTE: smart punctuation is deliberately OFF: it would turn the Hebrew
    // gershayim in acronyms like צה"ל into curly quotes.

    let mut out: Vec<Event> = Vec::new();
    let mut slugs = SlugCounter::default();
    let mut title: Option<String> = None;
    let mut words = 0usize;
    let mut has_math = false;
    let mut has_mermaid = false;
    let mut has_graphviz = false;

    // code block state
    let mut code: Option<(String, String)> = None; // (lang, body)
    // heading state
    let mut heading: Option<(HeadingLevel, Option<String>, Vec<String>, Vec<Event>, String)> = None;
    let mut in_meta = false;

    for ev in Parser::new_ext(src, opts) {
        if in_meta {
            if matches!(ev, Event::End(TagEnd::MetadataBlock(_))) {
                in_meta = false;
            }
            continue;
        }
        if let Some((_, body)) = code.as_mut() {
            match ev {
                Event::Text(t) => body.push_str(&t),
                Event::End(TagEnd::CodeBlock) => {
                    let (lang, body) = code.take().unwrap();
                    let html = match lang.to_ascii_lowercase().as_str() {
                        // GitHub-style ```math block → display equation (typeset by KaTeX in the UI)
                        "math" => {
                            has_math = true;
                            format!("<p class=\"math-block\"><span class=\"math math-display\">{}</span></p>\n", escape_html(&body))
                        }
                        // ```mermaid → diagram (drawn by Mermaid in the UI; source kept as fallback)
                        "mermaid" => {
                            has_mermaid = true;
                            format!("<div class=\"mermaid-block\" dir=\"ltr\"><pre class=\"mermaid-src\">{}</pre></div>\n", escape_html(&body))
                        }
                        // ```dot / ```graphviz → graph (laid out by Graphviz / Viz.js in the UI)
                        "dot" | "graphviz" | "gv" => {
                            has_graphviz = true;
                            format!("<div class=\"graphviz-block\" dir=\"ltr\"><pre class=\"graphviz-src\">{}</pre></div>
", escape_html(&body))
                        }
                        _ => highlight(&lang, &body),
                    };
                    out.push(Event::Html(html.into()));
                }
                _ => {}
            }
            continue;
        }
        if let Some(h) = heading.as_mut() {
            match ev {
                Event::End(TagEnd::Heading(_)) => {
                    let (level, id, classes, inner, text) = heading.take().unwrap();
                    let text = text.trim().to_string();
                    if level == HeadingLevel::H1 && title.is_none() && !text.is_empty() {
                        title = Some(text.clone());
                    }
                    let id = match id {
                        Some(id) => slugs.claim(&id),
                        None => slugs.claim(&slugify(&text)),
                    };
                    let mut inner_html = String::new();
                    html::push_html(&mut inner_html, inner.into_iter());
                    let n = level as usize;
                    let class = if classes.is_empty() {
                        String::new()
                    } else {
                        format!(" class=\"{}\"", escape_attr(&classes.join(" ")))
                    };
                    out.push(Event::Html(
                        format!("<h{n} id=\"{}\"{class}>{inner_html}</h{n}>\n", escape_attr(&id)).into(),
                    ));
                }
                ev => {
                    if matches!(ev, Event::InlineMath(_) | Event::DisplayMath(_)) {
                        has_math = true;
                    }
                    if let Event::Text(t) | Event::Code(t) = &ev {
                        h.4.push_str(t);
                        words += count_words(t);
                    }
                    h.3.push(ev);
                }
            }
            continue;
        }
        match ev {
            Event::Start(Tag::MetadataBlock(_)) => in_meta = true,
            Event::Start(Tag::CodeBlock(kind)) => {
                let lang = match kind {
                    CodeBlockKind::Fenced(info) => info.split([' ', ',', '{']).next().unwrap_or("").to_string(),
                    CodeBlockKind::Indented => String::new(),
                };
                code = Some((lang, String::new()));
            }
            Event::Start(Tag::Heading { level, id, classes, .. }) => {
                heading = Some((
                    level,
                    id.map(|s| s.to_string()),
                    classes.iter().map(|c| c.to_string()).collect(),
                    Vec::new(),
                    String::new(),
                ));
            }
            Event::Text(ref t) => {
                words += count_words(t);
                out.push(ev);
            }
            Event::InlineMath(_) | Event::DisplayMath(_) => {
                has_math = true;
                out.push(ev);
            }
            ev => out.push(ev),
        }
    }

    let mut raw = String::with_capacity(src.len() * 3 / 2);
    html::push_html(&mut raw, out.into_iter());

    Rendered { html: sanitizer().clean(&raw).to_string(), title, words, has_math, has_mermaid, has_graphviz }
}

fn count_words(s: &str) -> usize {
    s.split_whitespace().filter(|w| w.chars().any(char::is_alphanumeric)).count()
}

fn escape_attr(s: &str) -> String {
    s.replace('&', "&amp;").replace('"', "&quot;").replace('<', "&lt;").replace('>', "&gt;")
}

fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// GitHub-style slug that keeps letters of every script (Hebrew, Arabic, …).
pub fn slugify(text: &str) -> String {
    let mut s = String::with_capacity(text.len());
    for c in text.trim().chars() {
        // Hebrew cantillation, niqqud and punctuation (U+0591–U+05C7): drop.
        if ('\u{0591}'..='\u{05C7}').contains(&c) {
            continue;
        }
        if c.is_alphanumeric() || c == '_' || c == '-' {
            s.extend(c.to_lowercase());
        } else if c.is_whitespace() {
            s.push('-');
        }
        // Hebrew niqqud / combining marks are dropped together with punctuation
    }
    if s.is_empty() { "section".into() } else { s }
}

#[derive(Default)]
struct SlugCounter {
    used: HashSet<String>,
    counts: HashMap<String, usize>,
}

impl SlugCounter {
    fn claim(&mut self, base: &str) -> String {
        let mut candidate = base.to_string();
        while self.used.contains(&candidate) {
            let n = self.counts.entry(base.to_string()).or_insert(0);
            *n += 1;
            candidate = format!("{base}-{n}");
        }
        self.used.insert(candidate.clone());
        candidate
    }
}

fn highlight(lang: &str, code: &str) -> String {
    let lang_attr = escape_attr(lang);
    let label = if lang.is_empty() { String::new() } else { format!(" data-lang=\"{lang_attr}\"") };
    let class = if lang.is_empty() { String::new() } else { format!(" class=\"language-{lang_attr}\"") };

    // Large blocks or unknown languages: plain text, keeps huge files fast.
    if !lang.is_empty() && code.len() < 256 * 1024 {
        let ss = syntax_set();
        let syntax = ss
            .find_syntax_by_token(lang)
            .or_else(|| ss.find_syntax_by_extension(lang))
            .or_else(|| alias(lang).and_then(|l| ss.find_syntax_by_token(l)));
        if let Some(syntax) = syntax {
            let mut hl = ClassedHTMLGenerator::new_with_class_style(syntax, ss, CLASS_STYLE);
            let ok = LinesWithEndings::from(code).all(|line| hl.parse_html_for_line_which_includes_newline(line).is_ok());
            if ok {
                return format!("<pre dir=\"ltr\"{label}><code{class}>{}</code></pre>\n", hl.finalize());
            }
        }
    }
    format!("<pre dir=\"ltr\"{label}><code{class}>{}</code></pre>\n", escape_html(code))
}

fn alias(lang: &str) -> Option<&'static str> {
    Some(match lang.to_ascii_lowercase().as_str() {
        "ts" | "typescript" | "tsx" | "jsx" | "javascript" | "node" | "mjs" | "cjs" => "js",
        "sh" | "shell" | "zsh" | "console" | "bash" => "bash",
        "ps" | "ps1" | "pwsh" | "powershell" => "bash",
        "yml" => "yaml",
        "toml" | "ini" | "cfg" | "conf" => "ini",
        "c++" | "cxx" | "hpp" => "cpp",
        "cs" | "csharp" | "c#" => "cs",
        "py" | "python3" => "python",
        "rs" => "rust",
        "kt" | "kotlin" => "java",
        "html" | "xml" | "svg" | "vue" => "html",
        "json5" | "jsonc" => "json",
        "dockerfile" | "docker" => "bash",
        _ => return None,
    })
}

fn sanitizer() -> &'static ammonia::Builder<'static> {
    static B: OnceLock<ammonia::Builder<'static>> = OnceLock::new();
    B.get_or_init(|| {
        let mut b = ammonia::Builder::default();
        b.add_generic_attributes(["id", "class", "dir", "lang", "align", "title"]);
        b.add_tags(["input", "kbd", "mark", "details", "summary", "figure", "figcaption", "picture", "source", "video", "audio", "u", "ins", "section"]);
        b.add_tag_attributes("input", ["type", "checked", "disabled"]);
        b.add_tag_attributes("img", ["width", "height", "loading", "align"]);
        b.add_tag_attributes("pre", ["data-lang"]);
        b.add_tag_attributes("ol", ["start", "type", "reversed"]);
        b.add_tag_attributes("td", ["colspan", "rowspan", "style"]);
        b.add_tag_attributes("th", ["colspan", "rowspan", "style"]);
        b.add_tag_attributes("details", ["open"]);
        b.add_tag_attributes("source", ["src", "srcset", "type", "media"]);
        b.add_tag_attributes("video", ["src", "controls", "width", "height", "poster", "loop", "muted"]);
        b.add_tag_attributes("audio", ["src", "controls", "loop"]);
        b.add_tag_attributes("a", ["name"]);
        b.add_tag_attributes("p", ["align"]);
        b.add_tag_attributes("div", ["align"]);
        b.add_url_schemes(["file"]);
        b.link_rel(None);
        // id/class are attacker-free here (no scripts run), but keep them from
        // clobbering the reader UI's own ids.
        b.id_prefix(None);
        b
    })
}

/// CSS for syntax highlighting: a light theme plus a dark theme scoped under
/// `:root[data-theme="dark"]`.
pub fn highlight_css() -> &'static str {
    static CSS: OnceLock<String> = OnceLock::new();
    CSS.get_or_init(|| {
        let themes = syntect::highlighting::ThemeSet::load_defaults();
        let light = css_for_theme_with_class_style(&themes.themes["InspiredGitHub"], CLASS_STYLE).unwrap_or_default();
        let dark = css_for_theme_with_class_style(&themes.themes["base16-ocean.dark"], CLASS_STYLE).unwrap_or_default();
        let mut css = String::new();
        css.push_str(&strip_code_rule(&light));
        css.push('\n');
        css.push_str(&scope(&strip_code_rule(&dark), ":root[data-theme=\"dark\"]"));
        css
    })
}

/// Drop the theme's `.hl-code` block background; the app styles <pre> itself.
fn strip_code_rule(css: &str) -> String {
    let mut out = String::new();
    let mut skipping = false;
    for line in css.lines() {
        if line.trim_start().starts_with(".hl-code") {
            skipping = true;
        }
        if !skipping {
            out.push_str(line);
            out.push('\n');
        }
        if skipping && line.contains('}') {
            skipping = false;
        }
    }
    out
}

fn scope(css: &str, prefix: &str) -> String {
    let mut out = String::new();
    for line in css.lines() {
        if line.contains('{') && !line.starts_with(' ') && !line.starts_with('\t') {
            let (sel, rest) = line.split_at(line.find('{').unwrap());
            let scoped: Vec<String> = sel
                .split(',')
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .map(|s| format!("{prefix} {s}"))
                .collect();
            out.push_str(&scoped.join(", "));
            out.push(' ');
            out.push_str(rest);
        } else {
            out.push_str(line);
        }
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hebrew_slugs() {
        assert_eq!(slugify("שלום עולם!"), "שלום-עולם");
        assert_eq!(slugify("Hello, World"), "hello-world");
        assert_eq!(slugify("בְּרֵאשִׁית"), "בראשית");
    }

    #[test]
    fn duplicate_headings_get_suffixes() {
        let r = render("# A\n## A\n## A\n");
        assert!(r.html.contains("id=\"a\""));
        assert!(r.html.contains("id=\"a-1\""));
        assert!(r.html.contains("id=\"a-2\""));
        assert_eq!(r.title.as_deref(), Some("A"));
    }

    #[test]
    fn scripts_are_stripped() {
        let r = render("hi <script>alert(1)</script> <img src=x onerror=alert(1)>");
        assert!(!r.html.contains("<script"));
        assert!(!r.html.contains("onerror"));
    }

    #[test]
    fn code_is_highlighted_and_ltr() {
        let r = render("```rust\nfn main() {}\n```\n");
        assert!(r.html.contains("hl-"), "{}", r.html);
        assert!(r.html.contains("dir=\"ltr\""));
    }

    #[test]
    fn tasklists_and_tables_survive_sanitizer() {
        let r = render("- [x] done\n\n| a | b |\n|---|---|\n| 1 | 2 |\n");
        assert!(r.html.contains("type=\"checkbox\""));
        assert!(r.html.contains("<table>"));
    }

    #[test]
    fn math_is_marked_for_katex() {
        let r = render(r"Euler: $e^{i\pi}+1=0$

$$\int_0^1 x\,dx$$

```math
a^2+b^2=c^2
```
");
        assert!(r.has_math);
        assert!(r.html.contains("class=\"math math-inline\""), "{}", r.html);
        assert!(r.html.contains("class=\"math math-display\""), "{}", r.html);
        assert!(r.html.contains("a^2+b^2=c^2"));
    }

    #[test]
    fn prices_are_not_math() {
        let r = render("It costs $5 and $10 today.");
        assert!(!r.has_math, "{}", r.html);
    }

    #[test]
    fn mermaid_block_kept_as_source() {
        let r = render("```mermaid
graph TD; A-->B
```
");
        assert!(r.has_mermaid);
        assert!(r.html.contains("mermaid-src"));
        assert!(r.html.contains("A--&gt;B"), "{}", r.html);
    }

    #[test]
    fn graphviz_block_kept_as_source() {
        let r = render("```dot
digraph { \"שלום\" -> b }
```
");
        assert!(r.has_graphviz && !r.has_mermaid);
        assert!(r.html.contains("class=\"graphviz-src\""), "{}", r.html);
        assert!(r.html.contains("-&gt; b"), "{}", r.html);
        assert!(!render("```rust
fn main() {}
```
").has_graphviz);
    }

    #[test]
    fn mermaid_cannot_smuggle_html() {
        let r = render("```mermaid
<img src=x onerror=alert(1)>
```
");
        assert!(!r.html.contains("<img"));
    }

    #[test]
    fn front_matter_hidden() {
        let r = render("---\ntitle: x\n---\n# Real\n");
        assert!(!r.html.contains("title: x"));
    }

    #[test]
    fn gershayim_not_curled() {
        let r = render("צה\"ל");
        assert!(r.html.contains("צה&quot;ל") || r.html.contains("צה\"ל"));
    }
}
