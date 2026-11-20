#!/bin/sh
# この Mac 向けの CLI だけをビルドして、アプリの更新と同じ鍵で署名する（手元での確かめ用）。
# 署名の鍵は TAURI_SIGNING_PRIVATE_KEY（と TAURI_SIGNING_PRIVATE_KEY_PASSWORD）で渡す。
# 配布は .github/workflows/release-cli.yml で行う（macOS と Linux の全部を載せる）。ここで作る cli-latest.json は
# この Mac の分しか書かないので、リリースに載せない。
set -eu
cd "$(dirname "$0")/.."
version=$(sed -n 's/^version = "\(.*\)"$/\1/p' cli/Cargo.toml | head -1)
platform=macos-$(uname -m | sed 's/arm64/aarch64/')
asset=rootlore-$platform
mkdir -p dist-cli
cargo build --release --manifest-path cli/Cargo.toml
cp cli/target/release/rootlore "dist-cli/$asset"
(cd desktop && npx tauri signer sign "../dist-cli/$asset" >/dev/null)
signature=$(cat "dist-cli/$asset.sig")
url="https://github.com/tanakaisworking/rootlore/releases/download/cli-v$version/$asset"
printf '{\n  "version": "%s",\n  "platforms": {\n    "%s": { "url": "%s", "signature": "%s" }\n  }\n}\n' \
  "$version" "$platform" "$url" "$signature" > dist-cli/cli-latest.json
echo "dist-cli/: $asset, $asset.sig, cli-latest.json (version $version)"
