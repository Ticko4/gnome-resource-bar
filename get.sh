#!/usr/bin/env bash
# Install or update Resource Bar from the latest GitHub release, no build tools needed:
#   curl -fsSL https://raw.githubusercontent.com/Ticko4/gnome-resource-bar/main/get.sh | bash
set -euo pipefail

UUID="resource-bar@ticko4.github.io"
URL="${RB_ZIP_URL:-https://github.com/Ticko4/gnome-resource-bar/releases/latest/download/resource-bar.zip}"
SUPPORTED="51"   # keep in sync with "shell-version" in metadata.json

shell="$(gnome-shell --version 2>/dev/null | grep -oE '[0-9]+' | head -n1 || true)"
if [[ -z "$shell" ]]; then
    echo "GNOME Shell was not found: Resource Bar is a GNOME Shell extension." >&2
    exit 1
fi
if [[ " $SUPPORTED " != *" $shell "* ]]; then
    echo "Resource Bar supports GNOME Shell $SUPPORTED; this system has GNOME Shell $shell." >&2
    exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
zip="$tmp/resource-bar.zip"
echo "Downloading $URL"
if command -v curl >/dev/null; then
    curl -fsSL -o "$zip" "$URL"
elif command -v wget >/dev/null; then
    wget -qO "$zip" "$URL"
else
    gio copy "$URL" "$zip"
fi

# Unpacks into ~/.local/share/gnome-shell/extensions and compiles the settings schema.
gnome-extensions install --force "$zip"

# Mark it enabled so it starts at the next login (the running shell on Wayland
# only loads new extensions at login).
gjs -c "
    const {Gio} = imports.gi;
    const s = new Gio.Settings({schema_id: 'org.gnome.shell'});
    const on = s.get_strv('enabled-extensions');
    if (!on.includes('$UUID'))
        s.set_strv('enabled-extensions', [...on, '$UUID']);
    s.set_strv('disabled-extensions', s.get_strv('disabled-extensions').filter(u => u !== '$UUID'));
    Gio.Settings.sync();
"

if [[ "$(gsettings get org.gnome.shell disable-user-extensions 2>/dev/null)" == "true" ]]; then
    echo "Note: extensions are switched off in the Extensions app; switch them on to see Resource Bar."
fi
if gnome-extensions info "$UUID" >/dev/null 2>&1; then
    echo "Resource Bar updated: log out and back in to load the new version."
else
    echo "Resource Bar installed: log out and back in to see it in the top bar."
fi
