import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _, ngettext} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {DISK_IDS, N_, STATS, STAT_IDS, THRESHOLDS, fmt, isValidKey, makeKey, parseKey} from './lib/stats.js';
import {mountName, parseMounts} from './lib/mounts.js';

// Labels are marked with N_() and translated when the rows are built
// (gettext is not usable before the preferences object exists).
const VISUALIZATIONS = [
    ['gauge', N_('Gauge')],
    ['graph', N_('Graph')],
    ['none', N_('None')],
];

const GRAPH_COLORS = [
    ['default', N_('Default (text color)')],
    ['accent', N_('System accent color')],
    ['resources', N_('Per resource (like Resources)')],
];

const POSITIONS = [
    ['left', N_('Left')],
    ['center', N_('Center')],
    ['right', N_('Right')],
];

const NET_UNITS = [
    ['auto', N_('Automatic')],
    ['kb', 'kB/s'],
    ['mb', 'MB/s'],
];

function listInterfaces() {
    try {
        const [, bytes] = GLib.file_get_contents('/proc/net/dev');
        return new TextDecoder().decode(bytes).split('\n').slice(2)
            .map(l => l.split(':')[0].trim())
            .filter(n => n && n !== 'lo');
    } catch {
        return [];
    }
}

function listDisks() {
    try {
        const [, bytes] = GLib.file_get_contents('/proc/self/mounts');
        return parseMounts(new TextDecoder().decode(bytes));
    } catch {
        return [];
    }
}

// Adw.ComboRow bound to a string key with a fixed [value, label] list.
function choiceRow(settings, key, title, choices, subtitle = '') {
    const row = new Adw.ComboRow({
        title,
        subtitle,
        model: Gtk.StringList.new(choices.map(c => _(c[1]))),
    });
    const sync = () => {
        const idx = choices.findIndex(c => c[0] === settings.get_string(key));
        row.selected = Math.max(0, idx);
    };
    sync();
    row.connect('notify::selected', () => {
        const value = choices[row.selected]?.[0];
        if (value !== undefined && value !== settings.get_string(key))
            settings.set_string(key, value);
    });
    const id = settings.connect(`changed::${key}`, sync);
    row.connect('destroy', () => settings.disconnect(id));
    return row;
}

function switchRow(settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function spinRow(settings, key, title, {min, max, step, digits = 0, subtitle = ''}) {
    const row = Adw.SpinRow.new_with_range(min, max, step);
    row.set({title, subtitle, digits});
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

export default class ResourceBarPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;
        window.set_default_size(640, 760);
        window.set_search_enabled(true);

        window.add(this._panelPage(settings));
        window.add(this._monitorPage(settings));
        window.add(this._thresholdsPage(settings));
    }

    _icon(name) {
        const file = Gio.File.new_for_path(`${this.path}/icons/${name}-symbolic.svg`);
        return new Gtk.Image({gicon: new Gio.FileIcon({file}), pixel_size: 16});
    }

    // ---------- Panel page ----------

    _panelPage(settings) {
        const page = new Adw.PreferencesPage({title: _('Top Bar'), icon_name: 'view-app-grid-symbolic'});

        const statsGroup = new Adw.PreferencesGroup({
            title: _('Metrics in the top bar'),
            description: _('Each metric becomes an item with an icon, a gauge or graph and its value, like Noctalia’s sysmon widget.'),
        });
        const list = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE, css_classes: ['boxed-list']});
        statsGroup.add(list);
        page.add(statsGroup);

        const disks = listDisks();

        const rebuildList = () => {
            list.remove_all();
            const enabled = settings.get_strv('stats').filter(isValidKey);
            const defaultDisk = settings.get_string('disk-path') || '/';
            const save = keys => settings.set_strv('stats', keys);
            // Mount a disk stat reads: its own param or the default disk.
            const diskOf = key => {
                const {id, param} = parseKey(key);
                return DISK_IDS.includes(id) ? param || defaultDisk : null;
            };

            enabled.forEach((key, i) => {
                const {id, param} = parseKey(key);
                let subtitle = id;
                if (DISK_IDS.includes(id))
                    subtitle = param ? `${id} · ${param}` : `${id} · ${fmt(_('default (%s)'), defaultDisk)}`;
                const row = new Adw.ActionRow({
                    title: param ? `${_(STATS[id].name)} — ${mountName(param)}` : _(STATS[id].name),
                    subtitle,
                });
                row.add_prefix(this._icon(STATS[id].icon));
                const mk = (icon, tooltip, sensitive, cb) => {
                    const b = new Gtk.Button({
                        icon_name: icon,
                        tooltip_text: tooltip,
                        sensitive,
                        valign: Gtk.Align.CENTER,
                        css_classes: ['flat', 'circular'],
                    });
                    b.connect('clicked', cb);
                    row.add_suffix(b);
                };
                mk('go-up-symbolic', _('Move up'), i > 0, () => {
                    const keys = [...enabled];
                    [keys[i - 1], keys[i]] = [keys[i], keys[i - 1]];
                    save(keys);
                });
                mk('go-down-symbolic', _('Move down'), i < enabled.length - 1, () => {
                    const keys = [...enabled];
                    [keys[i + 1], keys[i]] = [keys[i], keys[i + 1]];
                    save(keys);
                });
                mk('user-trash-symbolic', _('Remove'), true, () => save(enabled.filter((_k, j) => j !== i)));
                list.append(row);
            });

            // Disk stats can be added once per disk; the others only once.
            const available = STAT_IDS.filter(id => DISK_IDS.includes(id) || !enabled.includes(id));
            if (available.length > 0) {
                const addRow = new Adw.ActionRow({title: _('Add metric')});
                const dropdown = Gtk.DropDown.new_from_strings(available.map(id => _(STATS[id].name)));
                dropdown.valign = Gtk.Align.CENTER;
                const diskChoices = [['', fmt(_('Default (%s)'), defaultDisk)], ...disks.map(d => [d.path, mountName(d.path)])];
                const diskDropdown = Gtk.DropDown.new_from_strings(diskChoices.map(c => c[1]));
                diskDropdown.set({valign: Gtk.Align.CENTER, tooltip_text: _('Disk')});
                const syncDisk = () => {
                    diskDropdown.visible = DISK_IDS.includes(available[dropdown.selected]);
                };
                dropdown.connect('notify::selected', syncDisk);
                syncDisk();
                const add = new Gtk.Button({
                    icon_name: 'list-add-symbolic',
                    tooltip_text: _('Add'),
                    valign: Gtk.Align.CENTER,
                    css_classes: ['suggested-action', 'circular'],
                });
                add.connect('clicked', () => {
                    const id = available[dropdown.selected];
                    const param = DISK_IDS.includes(id) ? diskChoices[diskDropdown.selected][0] : '';
                    const key = makeKey(id, param);
                    if (!enabled.includes(key))
                        save([...enabled, key]);
                });
                addRow.add_suffix(dropdown);
                addRow.add_suffix(diskDropdown);
                addRow.add_suffix(add);
                list.append(addRow);
            }

            // One "Disk used (%)" per disk that has no disk stat yet.
            const shown = new Set(enabled.map(diskOf).filter(Boolean));
            const missing = disks.filter(d => !shown.has(d.path));
            const allRow = new Adw.ActionRow({
                title: _('All disks'),
                subtitle: missing.length > 0
                    // TRANSLATORS: %s is a list of disk names.
                    ? fmt(_('Adds “Disk used (%)” for: %s'), missing.map(d => mountName(d.path)).join(', '))
                    : fmt(ngettext('The %d detected disk is already in the top bar',
                        'All %d detected disks are already in the top bar', disks.length), disks.length),
            });
            const addAll = new Gtk.Button({
                label: _('Add all'),
                sensitive: missing.length > 0,
                valign: Gtk.Align.CENTER,
            });
            addAll.connect('clicked', () =>
                save([...enabled, ...missing.map(d => makeKey('disk_used_pct', d.path))]));
            allRow.add_suffix(addAll);
            list.append(allRow);
        };
        rebuildList();
        const statsId = settings.connect('changed::stats', rebuildList);
        const diskId = settings.connect('changed::disk-path', rebuildList);
        page.connect('destroy', () => {
            settings.disconnect(statsId);
            settings.disconnect(diskId);
        });

        // Appearance
        const look = new Adw.PreferencesGroup({title: _('Appearance')});
        look.add(choiceRow(settings, 'visualization', _('Visualization'), VISUALIZATIONS,
            _('Vertical pill gauge or a graph of the last 30 readings')));
        look.add(switchRow(settings, 'show-icon', _('Show icon')));
        look.add(switchRow(settings, 'show-value', _('Show value')));
        look.add(switchRow(settings, 'show-units', _('Show units'), _('Off: “45” instead of “45°C”')));
        look.add(switchRow(settings, 'show-cpu-cores', _('Per-core gauge'),
            _('For CPU usage in gauge mode, one bar per core')));
        look.add(spinRow(settings, 'label-min-width', _('Minimum value width'),
            {min: 0, max: 200, step: 1, subtitle: _('In pixels; reserves room so the top bar does not shift')}));
        look.add(spinRow(settings, 'spacing', _('Spacing between metrics'), {min: 0, max: 40, step: 1}));

        look.add(switchRow(settings, 'smooth-animation', _('Smooth animation'),
            _('Gauges and graphs glide between readings instead of jumping on every update')));
        look.add(choiceRow(settings, 'graph-colors', _('Graph colors'), GRAPH_COLORS,
            _('Only graphs change; gauges, icons and values stay as they are')));

        const colorRow = new Adw.ActionRow({
            title: _('Alert color'),
            subtitle: _('Used when a value goes past its activity and critical thresholds'),
        });
        const colorButton = new Gtk.ColorDialogButton({
            dialog: new Gtk.ColorDialog({with_alpha: false}),
            valign: Gtk.Align.CENTER,
        });
        const syncColor = () => {
            const rgba = new Gdk.RGBA();
            if (rgba.parse(settings.get_string('highlight-color')))
                colorButton.rgba = rgba;
        };
        syncColor();
        colorButton.connect('notify::rgba', () => {
            const c = colorButton.rgba;
            const hex = `#${[c.red, c.green, c.blue]
                .map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
            if (hex !== settings.get_string('highlight-color').toUpperCase())
                settings.set_string('highlight-color', hex);
        });
        const resetColor = new Gtk.Button({
            icon_name: 'edit-undo-symbolic',
            tooltip_text: _('Reset to default'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat', 'circular'],
        });
        resetColor.connect('clicked', () => settings.reset('highlight-color'));
        const colorId = settings.connect('changed::highlight-color', syncColor);
        page.connect('destroy', () => settings.disconnect(colorId));
        colorRow.add_suffix(resetColor);
        colorRow.add_suffix(colorButton);
        look.add(colorRow);
        page.add(look);

        // Position
        const pos = new Adw.PreferencesGroup({title: _('Position')});
        pos.add(choiceRow(settings, 'panel-position', _('Top bar area'), POSITIONS));
        pos.add(spinRow(settings, 'panel-index', _('Position in the area'),
            {min: -1, max: 50, step: 1, subtitle: _('0 = first item; -1 = last')}));
        page.add(pos);

        return page;
    }

    // ---------- Monitoring page ----------

    _monitorPage(settings) {
        const page = new Adw.PreferencesPage({title: _('Monitoring'), icon_name: 'utilities-system-monitor-symbolic'});

        const general = new Adw.PreferencesGroup({title: _('General')});
        general.add(spinRow(settings, 'update-interval', _('Update interval'),
            {min: 0.5, max: 10, step: 0.5, digits: 1, subtitle: _('Seconds between readings')}));
        page.add(general);

        const disk = new Adw.PreferencesGroup({
            title: _('Default disk'),
            description: _('Used by disk metrics that do not name a specific disk. The menu always lists every disk.'),
        });
        const diskRow = new Adw.EntryRow({
            title: _('Mount point'),
            text: settings.get_string('disk-path'),
            show_apply_button: true,
        });
        diskRow.connect('apply', () => {
            const path = diskRow.text.trim() || '/';
            settings.set_string('disk-path', path);
        });
        disk.add(diskRow);
        page.add(disk);

        const net = new Adw.PreferencesGroup({title: _('Network')});
        const current = settings.get_string('network-interface');
        const ifaces = listInterfaces();
        if (current && !ifaces.includes(current))
            ifaces.push(current);
        net.add(choiceRow(settings, 'network-interface', _('Interface'),
            [['', N_('Automatic (physical interfaces)')], ...ifaces.map(i => [i, i])]));
        net.add(choiceRow(settings, 'network-speed-unit', _('Unit'), NET_UNITS));
        net.add(switchRow(settings, 'network-speed-compact', _('Compact format'), _('E.g. “1.2M” instead of “1.2 MB/s”')));
        net.add(spinRow(settings, 'network-speed-decimals', _('Decimal places (compact)'), {min: 0, max: 2, step: 1}));
        page.add(net);

        return page;
    }

    // ---------- Thresholds page ----------

    _thresholdsPage(settings) {
        const page = new Adw.PreferencesPage({title: _('Thresholds'), icon_name: 'dialog-warning-symbolic'});
        const group = new Adw.PreferencesGroup({
            title: _('Color thresholds'),
            description: _('Below the activity threshold a metric uses the normal top bar color. ' +
                'Between activity and critical it moves toward the alert color, and at critical it is fully that color.'),
        });

        const read = () => settings.get_value('thresholds').deepUnpack();
        const write = (key, idx, value) => {
            const all = read();
            const cur = all[key] ?? [...THRESHOLDS[key].defaults];
            const next = [...cur];
            next[idx] = value;
            all[key] = next;
            settings.set_value('thresholds', new GLib.Variant('a{s(dd)}', all));
        };

        const rows = [];
        for (const [key, def] of Object.entries(THRESHOLDS)) {
            const exp = new Adw.ExpanderRow({title: _(def.name)});
            const mk = (idx, title) => {
                const r = Adw.SpinRow.new_with_range(def.min, def.max, def.step);
                r.set({title: `${title} (${def.unit})`, digits: def.digits});
                r.connect('notify::value', () => {
                    if (r._syncing)
                        return;
                    write(key, idx, r.value);
                });
                exp.add_row(r);
                return r;
            };
            const activity = mk(0, _('Activity'));
            const critical = mk(1, _('Critical'));
            rows.push({key, def, exp, activity, critical});
            group.add(exp);
        }

        const sync = () => {
            const all = read();
            for (const {key, def, exp, activity, critical} of rows) {
                const [a, c] = all[key] ?? def.defaults;
                for (const [r, v] of [[activity, a], [critical, c]]) {
                    r._syncing = true;
                    r.value = v;
                    r._syncing = false;
                }
                exp.subtitle = `${a.toFixed(def.digits)} → ${c.toFixed(def.digits)} ${def.unit}`;
            }
        };
        sync();
        const id = settings.connect('changed::thresholds', sync);
        page.connect('destroy', () => settings.disconnect(id));
        page.add(group);

        const resetGroup = new Adw.PreferencesGroup();
        const reset = new Gtk.Button({
            label: _('Reset thresholds'),
            halign: Gtk.Align.CENTER,
            css_classes: ['pill'],
        });
        reset.connect('clicked', () => settings.reset('thresholds'));
        resetGroup.add(reset);
        page.add(resetGroup);

        return page;
    }
}
