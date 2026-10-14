#!/bin/sh
set -eu
# The controller supplies a fresh writable build tree. All caches in the image
# are read-only during execution; no dependency downloads occur at runtime.
mkdir -p "$HOME"
mkdir -p "$CARGO_HOME"
ln -s /usr/local/cargo/registry "$CARGO_HOME/registry"
if [ -d /inputs ]; then cp -R /inputs/. /work/; fi
if [ -f /work/package-lock.json ]; then
  (cd /work && sha256sum -c /opt/qi-cache/locks.sha256) >&2
  # Vite writes its bundled config/cache beneath node_modules. Each check needs
  # its own writable copy; a symlink into the read-only image fails at runtime.
  if [ ! -e /work/node_modules ]; then cp -R /opt/qi-cache/node_modules /work/node_modules; fi
  mkdir -p /work/apps/tui-rs/target
  cp -R /opt/qi-cache/target/. /work/apps/tui-rs/target/
fi
exec "$@"
