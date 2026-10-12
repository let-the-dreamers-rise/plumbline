use std::path::PathBuf;

fn main() {
    // Path-independent guest build: every absolute path rustc would embed in the guest ELF (panic
    // locations of the ../../lib path dependency and of crates under CARGO_HOME) is remapped, so the
    // image ids are the same for any checkout directory. risc0-build strips CARGO_* from the guest
    // cargo's environment but keeps RUSTC_WRAPPER and these variables.
    let methods = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let src = methods.parent().unwrap().parent().unwrap(); // sealed-eval-zk/
    let cargo_home = std::env::var("CARGO_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(std::env::var("HOME").unwrap()).join(".cargo"));
    std::env::set_var("RUSTC_WRAPPER", methods.join("remap-rustc.sh"));
    std::env::set_var("TESSERA_REMAP_SRC", src);
    std::env::set_var("TESSERA_REMAP_CARGO_HOME", cargo_home);
    println!("cargo:rerun-if-changed=remap-rustc.sh");
    println!("cargo:rerun-if-env-changed=CARGO_HOME");
    risc0_build::embed_methods();
}
