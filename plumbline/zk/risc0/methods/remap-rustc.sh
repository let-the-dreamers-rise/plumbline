#!/bin/sh
# RUSTC_WRAPPER for the guest build only (set by build.rs): strips the checkout path and CARGO_HOME
# from panic-location strings so the guest ELF, and so the image id, do not depend on where the repo
# or the cargo registry live. Invoked as: remap-rustc.sh <rustc> <args...>
exec "$@" --remap-path-prefix="$TESSERA_REMAP_SRC=/tessera" --remap-path-prefix="$TESSERA_REMAP_CARGO_HOME=/cargo"
