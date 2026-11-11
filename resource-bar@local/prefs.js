import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {DISK_IDS, STATS, STAT_IDS, THRESHOLDS, isValidKey, makeKey, parseKey} from './lib/stats.js';
import {mountName, parseMounts} from './lib/mounts.js';

const VISUALIZATIONS = [
    ['gauge', 'Medidor'],
    ['graph', 'Gráfico'],
    ['none', 'Nenhuma'],
];

const GRAPH_COLORS = [
    ['default', 'Padrão (cor do texto)'],
    ['accent', 'Cor de destaque do sistema'],
    ['resources', 'Por recurso (como o Resources)'],
];

const POSITIONS = [
    ['left', 'Esquerda'],
    ['center', 'Centro'],
    ['right', 'Direita'],
];

const NET_UNITS = [
    ['auto', 'Automática'],
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
        model: Gtk.StringList.new(choices.map(c => c[1])),
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
        const page = new Adw.PreferencesPage({title: 'Painel', icon_name: 'view-app-grid-symbolic'});

        const statsGroup = new Adw.PreferencesGroup({
            title: 'Métricas no painel',
            description: 'Cada métrica vira um item com ícone, medidor ou gráfico e valor, como no widget sysmon do Noctalia.',
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
                    subtitle = param ? `${id} · ${param}` : `${id} · padrão (${defaultDisk})`;
                const row = new Adw.ActionRow({
                    title: param ? `${STATS[id].name} — ${mountName(param)}` : STATS[id].name,
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
                mk('go-up-symbolic', 'Mover para cima', i > 0, () => {
                    const keys = [...enabled];
                    [keys[i - 1], keys[i]] = [keys[i], keys[i - 1]];
                    save(keys);
                });
                mk('go-down-symbolic', 'Mover para baixo', i < enabled.length - 1, () => {
                    const keys = [...enabled];
                    [keys[i + 1], keys[i]] = [keys[i], keys[i + 1]];
                    save(keys);
                });
                mk('user-trash-symbolic', 'Remover', true, () => save(enabled.filter((_k, j) => j !== i)));
                list.append(row);
            });

            // Disk stats can be added once per disk; the others only once.
            const available = STAT_IDS.filter(id => DISK_IDS.includes(id) || !enabled.includes(id));
            if (available.length > 0) {
                const addRow = new Adw.ActionRow({title: 'Adicionar métrica'});
                const dropdown = Gtk.DropDown.new_from_strings(available.map(id => STATS[id].name));
                dropdown.valign = Gtk.Align.CENTER;
                const diskChoices = [['', `Padrão (${defaultDisk})`], ...disks.map(d => [d.path, mountName(d.path)])];
                const diskDropdown = Gtk.DropDown.new_from_strings(diskChoices.map(c => c[1]));
                diskDropdown.set({valign: Gtk.Align.CENTER, tooltip_text: 'Disco'});
                const syncDisk = () => {
                    diskDropdown.visible = DISK_IDS.includes(available[dropdown.selected]);
                };
                dropdown.connect('notify::selected', syncDisk);
                syncDisk();
                const add = new Gtk.Button({
                    icon_name: 'list-add-symbolic',
                    tooltip_text: 'Adicionar',
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

            // One "Disco usado (%)" per disk that has no disk stat yet.
            const shown = new Set(enabled.map(diskOf).filter(Boolean));
            const missing = disks.filter(d => !shown.has(d.path));
            const allRow = new Adw.ActionRow({
                title: 'Todos os discos',
                subtitle: missing.length > 0
                    ? `Adiciona “Disco usado (%)” para: ${missing.map(d => mountName(d.path)).join(', ')}`
                    : `Todos os ${disks.length} discos detectados já estão no painel`,
            });
            const addAll = new Gtk.Button({
                label: 'Adicionar todos',
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
        const look = new Adw.PreferencesGroup({title: 'Aparência'});
        look.add(choiceRow(settings, 'visualization', 'Visualização', VISUALIZATIONS,
            'Medidor em pílula vertical ou gráfico com os últimos 30 valores'));
        look.add(switchRow(settings, 'show-icon', 'Mostrar ícone'));
        look.add(switchRow(settings, 'show-value', 'Mostrar valor'));
        look.add(switchRow(settings, 'show-units', 'Mostrar unidades', 'Desligado: “45” em vez de “45°C”'));
        look.add(switchRow(settings, 'show-cpu-cores', 'Medidor por núcleo',
            'No uso da CPU com visualização em medidor, uma barra por núcleo'));
        look.add(spinRow(settings, 'label-min-width', 'Largura mínima do valor',
            {min: 0, max: 200, step: 1, subtitle: 'Em pixels; evita que o painel “pule” quando o número muda'}));
        look.add(spinRow(settings, 'spacing', 'Espaço entre métricas', {min: 0, max: 40, step: 1}));

        look.add(switchRow(settings, 'smooth-animation', 'Animação suave',
            'Medidores e gráficos deslizam entre leituras em vez de saltar a cada atualização'));
        look.add(choiceRow(settings, 'graph-colors', 'Cores dos gráficos', GRAPH_COLORS,
            'Só os gráficos mudam; barras, ícones e valores continuam como estão'));

        const colorRow = new Adw.ActionRow({
            title: 'Cor de alerta',
            subtitle: 'Usada quando o valor passa dos limites de atividade e crítico',
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
            tooltip_text: 'Restaurar padrão',
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
        const pos = new Adw.PreferencesGroup({title: 'Posição'});
        pos.add(choiceRow(settings, 'panel-position', 'Área do painel', POSITIONS));
        pos.add(spinRow(settings, 'panel-index', 'Posição na área',
            {min: -1, max: 50, step: 1, subtitle: '0 = primeiro item; -1 = último'}));
        page.add(pos);

        return page;
    }

    // ---------- Monitoring page ----------

    _monitorPage(settings) {
        const page = new Adw.PreferencesPage({title: 'Monitoramento', icon_name: 'utilities-system-monitor-symbolic'});

        const general = new Adw.PreferencesGroup({title: 'Geral'});
        general.add(spinRow(settings, 'update-interval', 'Intervalo de atualização',
            {min: 0.5, max: 10, step: 0.5, digits: 1, subtitle: 'Segundos entre leituras'}));
        page.add(general);

        const disk = new Adw.PreferencesGroup({
            title: 'Disco padrão',
            description: 'Usado pelas métricas de disco que não indicam um disco específico. ' +
                'O menu do painel sempre lista todos os discos.',
        });
        const diskRow = new Adw.EntryRow({
            title: 'Ponto de montagem',
            text: settings.get_string('disk-path'),
            show_apply_button: true,
        });
        diskRow.connect('apply', () => {
            const path = diskRow.text.trim() || '/';
            settings.set_string('disk-path', path);
        });
        disk.add(diskRow);
        page.add(disk);

        const net = new Adw.PreferencesGroup({title: 'Rede'});
        const current = settings.get_string('network-interface');
        const ifaces = listInterfaces();
        if (current && !ifaces.includes(current))
            ifaces.push(current);
        net.add(choiceRow(settings, 'network-interface', 'Interface',
            [['', 'Automática (interfaces físicas)'], ...ifaces.map(i => [i, i])]));
        net.add(choiceRow(settings, 'network-speed-unit', 'Unidade', NET_UNITS));
        net.add(switchRow(settings, 'network-speed-compact', 'Formato compacto', 'Ex.: “1.2M” em vez de “1.2 MB/s”'));
        net.add(spinRow(settings, 'network-speed-decimals', 'Casas decimais (compacto)', {min: 0, max: 2, step: 1}));
        page.add(net);

        return page;
    }

    // ---------- Thresholds page ----------

    _thresholdsPage(settings) {
        const page = new Adw.PreferencesPage({title: 'Limites', icon_name: 'dialog-warning-symbolic'});
        const group = new Adw.PreferencesGroup({
            title: 'Limites de cor',
            description: 'Abaixo do limite de atividade a métrica usa a cor normal do painel. ' +
                'Entre atividade e crítico ela vai em direção à cor de alerta; no crítico fica totalmente nessa cor.',
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
            const exp = new Adw.ExpanderRow({title: def.name});
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
            const activity = mk(0, 'Atividade');
            const critical = mk(1, 'Crítico');
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
            label: 'Restaurar limites padrão',
            halign: Gtk.Align.CENTER,
            css_classes: ['pill'],
        });
        reset.connect('clicked', () => settings.reset('thresholds'));
        resetGroup.add(reset);
        page.add(resetGroup);

        return page;
    }
}
