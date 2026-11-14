//! Embeds the icons, manifest and version info into MadReader.exe.
use std::path::PathBuf;

fn main() {
    for f in ["assets/app.rc", "assets/app.manifest", "assets/app.ico", "assets/doc.ico", "Cargo.toml"] {
        println!("cargo:rerun-if-changed={f}");
    }
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
