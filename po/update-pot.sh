#!/usr/bin/env bash
# Regenerate po/resource-bar.pot from the sources. xgettext is run on a copy
# outside the git checkout (newer xgettext versions query git and choke on it).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UUID="resource-bar@ticko4.github.io"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/$UUID/lib"
cp "$ROOT/$UUID"/*.js "$TMP/$UUID/"
cp "$ROOT/$UUID"/lib/*.js "$TMP/$UUID/lib/"
cd "$TMP"
xgettext --from-code=UTF-8 --language=JavaScript \
    --keyword=_ --keyword=N_ --keyword=ngettext:1,2 --keyword=pgettext:1c,2 \
    --add-comments=TRANSLATORS: --package-name="Resource Bar" \
    --msgid-bugs-address="https://github.com/Ticko4/gnome-resource-bar/issues" \
    -o "$ROOT/po/resource-bar.pot" "$UUID"/*.js "$UUID"/lib/*.js
for po in "$ROOT"/po/*.po; do
    [[ -e "$po" ]] && msgmerge --quiet --update --backup=none "$po" "$ROOT/po/resource-bar.pot"
done
echo "Updated $ROOT/po/resource-bar.pot"
