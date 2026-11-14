//! Embeds the icons, manifest and version info into MadReader.exe.
use std::path::PathBuf;

fn main() {
    for f in ["assets/app.rc", "assets/app.manifest", "assets/app.ico", "assets/doc.ico", "Cargo.toml"] {
        println!("cargo:rerun-if-changed={f}");
    }
    embed_vendor();
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let v = |k: &str| std::env::var(k).unwrap();
    let assets = PathBuf::from(v("CARGO_MANIFEST_DIR")).join("assets");
    let rc = std::fs::read_to_string(assets.join("app.rc"))
        .unwrap()
        .replace("@ASSETS@", &assets.to_string_lossy().replace('\\', "/"))
        .replace("@MAJOR@", &v("CARGO_PKG_VERSION_MAJOR"))
        .replace("@MINOR@", &v("CARGO_PKG_VERSION_MINOR"))
        .replace("@PATCH@", &v("CARGO_PKG_VERSION_PATCH"))
        .replace("@VERSION@", &v("CARGO_PKG_VERSION"));
    let out = PathBuf::from(v("OUT_DIR")).join("app.rc");
    std::fs::write(&out, rc).unwrap();
    embed_resource::compile(&out, embed_resource::NONE).manifest_required().unwrap();
}

/// Generate `$OUT_DIR/vendor.rs`: a table of every file under assets/vendor
/// (KaTeX, Mermaid). Files over 64 KB are gzip-compressed to keep the exe small;
/// the app inflates them on first request.
fn embed_vendor() {
    use std::io::Write;
    let root = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("assets").join("vendor");
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").unwrap());
    println!("cargo:rerun-if-changed=assets/vendor");

    let mut files = Vec::new();
    collect(&root, &mut files);
    files.sort();

    let mut table = String::from("pub static VENDOR: &[(&str, &[u8], bool)] = &[\n");
    for f in files {
        let rel = f.strip_prefix(&root).unwrap().to_string_lossy().replace('\\', "/");
        if rel.ends_with("LICENSE") {
            continue;
        }
        let bytes = std::fs::read(&f).unwrap();
        let (path, gz) = if bytes.len() > 64 * 1024 {
            let gz_path = out_dir.join("vendor").join(format!("{rel}.gz"));
            std::fs::create_dir_all(gz_path.parent().unwrap()).unwrap();
            let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::best());
            enc.write_all(&bytes).unwrap();
            std::fs::write(&gz_path, enc.finish().unwrap()).unwrap();
            (gz_path, true)
        } else {
            (f.clone(), false)
        };
        table.push_str(&format!("    ({rel:?}, include_bytes!({:?}), {gz}),\n", path.to_string_lossy()));
    }
    table.push_str("];\n");
    std::fs::write(out_dir.join("vendor.rs"), table).unwrap();
}

fn collect(dir: &std::path::Path, out: &mut Vec<PathBuf>) {
    for e in std::fs::read_dir(dir).unwrap().flatten() {
        let p = e.path();
        if p.is_dir() {
            collect(&p, out);
        } else {
            out.push(p);
        }
    }
}
