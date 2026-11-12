# Translating Resource Bar

Resource Bar is a GNOME Shell extension: a row of system metrics (CPU, memory, disks, network, GPU) in
the GNOME top bar, with a dropdown menu of cards and a libadwaita preferences window.

- Template: `po/resource-bar.pot` (regenerate with `po/update-pot.sh`).
- One file per language: `po/<lang>.po`, using GNOME's language codes (`pt` is European Portuguese,
  `pt_BR` Brazilian, `zh_CN`, `zh_TW`, `sr` is Cyrillic…).
- Check your file: `msgfmt --check -o /dev/null po/<lang>.po` and `python3 po/check_po.py po/<lang>.po`.
- `po/pt_BR.po` is a complete translation you can look at for context.

## Style

- Follow the terminology the GNOME desktop already uses in your language (GNOME Shell, Settings,
  libadwaita). For example “top bar” is the GNOME top bar (Portuguese “painel superior”/“painel”,
  German “obere Leiste”, French “barre supérieure”).
- Sentence case and short labels, as in GNOME apps. No trailing period on titles or switches.
- Keep `%s` and `%d` exactly as in the source, same count and order. Keep `·`, `↓`, `↑`, `…`, `—` and the
  extra spaces in `Load %s   ·   Up %s`.
- Use your language’s quotation marks in place of “ ” where that is the norm.
- Do not translate: units (`%`, `°C`, `GHz`, `kB/s`, `MB/s`, `GiB`), `CPU`, `GPU`, `VRAM`, product and app
  names (`Resources`, `Noctalia`, `nvidia-smi`). `Swap`, `Download` and `Upload` may be translated if
  GNOME does so in your language.
- Use the plural forms of your language (`Plural-Forms` header), e.g. Russian has 3, Japanese 1.

## Where each string appears

Top bar menu (dropdown):
- `Open %s` — menu item that opens the system monitor app; `%s` is its name (e.g. “Resources”).
- `Settings` — menu item that opens the preferences.
- Card titles: `Memory`, `Network`, `Disks` (the CPU and GPU cards show “CPU” and the GPU model).
- `Load %s   ·   Up %s` — header line: load average (“1.20  0.98  0.75”) and uptime (“3h 12min”).
- `%d core` / `%d cores` — under the CPU card title (“16 cores”).
- `No swap` — memory card when there is no swap.
- `Interface %s` / `Physical interfaces` — network card: which interface(s) are counted.
- `%d disk` / `%d disks` — top-right of the Disks card.
- `Space` / `Activity` with context “disks card” — a small two-option switch next to the Disks title:
  space used on each disk vs. read/write activity. Keep both very short (about 10 characters).
- `Calculating…`, `Waiting for data…` — placeholders before the first reading.
- `Suspended (power saving)` — the GPU is in runtime suspend.

Metric names (preferences list, accessibility names, thresholds page):
- `CPU usage`, `CPU temperature`, `CPU frequency`, `GPU usage`, `GPU temperature`, `VRAM`, `VRAM (%)`,
  `VRAM used`, `Memory`, `Memory (%)`, `Memory used`, `Swap`, `Swap (%)`, `Disk used (%)`, `Disk used`,
  `Disk free (%)`, `Disk free`, `Disk activity` (share of time the disk is busy reading/writing, like
  iostat %util), `Disk (space used)` and `Disk (activity)` (threshold groups), `Download`, `Upload`.

Preferences window (pages “Top Bar”, “Monitoring”, “Thresholds”):
- `Gauge` — a small vertical pill-shaped meter; `Graph` — a small line chart of recent values;
  `None` — no visualization.
- `Default (text color)`, `System accent color`, `Per resource (like Resources)` — choices for the graph
  colors (“Resources” is an app name).
- `Left`, `Center`, `Right` — area of the top bar where the item goes.
- `Automatic`, `Automatic (physical interfaces)` — automatic choice of unit / network interfaces.
- `default (%s)` (lowercase, in a subtitle) and `Default (%s)` (a dropdown item): `%s` is a mount point
  such as `/`.
- `Adds “Disk used (%)” for: %s` — `%s` is a comma-separated list of disk names. `(%)` is a literal
  percent sign, not a placeholder.
- `The %d detected disk is already in the top bar` / `All %d detected disks are already in the top bar`.
- `Activity` / `Critical` (no context) — the two thresholds of a metric: above “activity” the color starts
  to change, at “critical” it is fully the alert color.
- `Alert color` — color used when a value crosses the thresholds.
