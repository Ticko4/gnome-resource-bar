#!/usr/bin/env bash
# Instala (ou atualiza) a extensão Resource Bar para o usuário atual.
#   ./install.sh          instala em ~/.local/share/gnome-shell/extensions
#   ./install.sh --pack   gera resource-bar@local.shell-extension.zip
set -euo pipefail

UUID="resource-bar@local"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$ROOT/$UUID"

glib-compile-schemas --strict "$SRC/schemas"

if [[ "${1:-}" == "--pack" ]]; then
    gnome-extensions pack "$SRC" --force --out-dir "$ROOT" \
        --extra-source=lib --extra-source=icons
    echo "Pacote criado: $ROOT/$UUID.shell-extension.zip"
    echo "Instale com: gnome-extensions install --force $ROOT/$UUID.shell-extension.zip"
    exit 0
fi

DEST="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"
rm -rf "$DEST"
mkdir -p "$(dirname "$DEST")"
cp -r "$SRC" "$DEST"
echo "Instalado em $DEST"

if gnome-extensions info "$UUID" >/dev/null 2>&1; then
    gnome-extensions enable "$UUID"
    echo "Extensão ativada. Se já estava ativa, encerre a sessão e entre de novo para carregar a nova versão."
else
    # The running shell does not know the extension yet (Wayland only scans
    # on login), so mark it enabled in GSettings; it starts on next login.
    gjs -c "
        const {Gio} = imports.gi;
        const s = new Gio.Settings({schema_id: 'org.gnome.shell'});
        const on = s.get_strv('enabled-extensions');
        if (!on.includes('$UUID'))
            s.set_strv('enabled-extensions', [...on, '$UUID']);
        s.set_strv('disabled-extensions', s.get_strv('disabled-extensions').filter(u => u !== '$UUID'));
        Gio.Settings.sync();
    "
    echo "Extensão marcada como ativa. No Wayland o GNOME Shell só carrega extensões novas no login:"
    echo "encerre a sessão e entre de novo para vê-la no painel."
fi
