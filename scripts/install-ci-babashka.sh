#!/usr/bin/env bash
set -euo pipefail

version="${BB_VERSION:-1.13.219}"
destination="${1:-$PWD/.bin}"

if [[ "$version" != "1.13.219" ]]; then
  echo "unsupported Babashka version: $version" >&2
  exit 2
fi

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)
    archive="babashka-${version}-linux-amd64-static.tar.gz"
    expected="9ac1fe988d7001625b30ef3e3307e67f8545505a7cb49a4aa179f578115a3e09"
    ;;
  Linux-aarch64|Linux-arm64)
    archive="babashka-${version}-linux-aarch64-static.tar.gz"
    expected="e8d7a9c66c364b80627a43cb6ba5c14fb6ac7e4af114e8e5d80f97551ccdfe11"
    ;;
  Darwin-x86_64)
    archive="babashka-${version}-macos-amd64.tar.gz"
    expected="a26e2640d813d676682b5aa4244863fdb4da022802684d2da1183e612456b101"
    ;;
  Darwin-arm64)
    archive="babashka-${version}-macos-aarch64.tar.gz"
    expected="57a45df1cee534081375f35d39a3cb5f334956e6d429e364adbf46e296d52cfb"
    ;;
  *)
    echo "unsupported CI platform: $(uname -s) $(uname -m)" >&2
    exit 2
    ;;
esac

download_dir="$(mktemp -d)"
trap 'rm -rf "$download_dir"' EXIT
url="https://github.com/babashka/babashka/releases/download/v${version}/${archive}"

curl --fail --location --retry 3 --output "$download_dir/$archive" "$url"
actual="$(shasum -a 256 "$download_dir/$archive" | awk '{print $1}')"
if [[ "$actual" != "$expected" ]]; then
  echo "Babashka checksum mismatch: expected $expected, got $actual" >&2
  exit 1
fi

mkdir -p "$destination"
tar -xzf "$download_dir/$archive" -C "$destination" bb
chmod 0755 "$destination/bb"
"$destination/bb" --version
