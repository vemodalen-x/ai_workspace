#!/usr/bin/env bash
set -euo pipefail
stage=$(realpath "${1:?pass the staged application directory}")
out=$(realpath -m "${2:?pass the release asset directory}")
version=$("$stage/runtime/node" -p "require(process.argv[1]).version" "$stage/package.json")
mkdir -p "$out"
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
mkdir -p "$work/deb/opt" "$work/deb/usr/bin" "$work/deb/usr/share/applications" "$work/deb/DEBIAN"
cp -a "$stage" "$work/deb/opt/ai-agent-workspace"
ln -s /opt/ai-agent-workspace/ai-agent-workspace "$work/deb/usr/bin/ai-agent-workspace"
cat > "$work/deb/usr/share/applications/ai-agent-workspace.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=AI Agent Workspace
Exec=ai-agent-workspace start
Terminal=true
Categories=Development;
EOF
cat > "$work/deb/DEBIAN/control" <<EOF
Package: ai-agent-workspace
Version: $version
Architecture: amd64
Maintainer: vemodalen-x <38976476+vemodalen-x@users.noreply.github.com>
Depends: git (>= 1:2.38), libc6 (>= 2.28), libstdc++6
Recommends: xdg-utils
Section: devel
Priority: optional
Description: Local Git workspaces for coding agents and reproducible command trials
EOF
dpkg-deb --root-owner-group -Zxz -z2 --build "$work/deb" "$out/ai-agent-workspace-linux-x64.deb"
tar -C "$work/deb/opt" -czf "$out/ai-agent-workspace-linux-x64.tar.gz" ai-agent-workspace
