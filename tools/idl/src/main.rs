//! Writes target/idl/fomocity.json (the file `anchor build` would produce) and a committed
//! copy at idls/fomocity.json.
//! Run from the repo root: cargo run --manifest-path tools/idl/Cargo.toml
use std::{fs, path::PathBuf};

fn main() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let idl = anchor_lang_idl::build::IdlBuilder::new()
        .program_path(root.join("programs/fomocity"))
        .build()
        .expect("IDL build failed");
    let json = serde_json::to_string_pretty(&idl).unwrap();
    let out = root.join("target/idl");
    fs::create_dir_all(&out).unwrap();
    fs::write(out.join("fomocity.json"), &json).unwrap();
    // Committed copy, used by scripts/ and the web client.
    fs::write(root.join("idls/fomocity.json"), &json).unwrap();
    println!("wrote target/idl/fomocity.json + idls/fomocity.json ({} instructions)", idl.instructions.len());
}
