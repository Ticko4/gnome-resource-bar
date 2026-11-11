// Dropdown content: header with load/uptime and a grid of cards (CPU,
// memory, network, GPU with history graphs) plus a card listing every disk.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {categoryOf, diskUtilKey, formatDuration, formatRate, formatUsage, gradientFactor} from './stats.js';
import {mountName} from './mounts.js';
import {graphBaseColor, mixColors, toCss, withAlpha} from './color.js';
import {CoreGauges, Gauge, Graph, iconFor} from './widgets.js';

const VERTICAL = Clutter.Orientation.VERTICAL;

class Card {
    constructor(title, icon, extensionPath) {
        this.actor = new St.BoxLayout({
            orientation: VERTICAL,
            style_class: 'resource-bar-card',
            x_expand: true,
        });

        const header = new St.BoxLayout({style_class: 'resource-bar-card-header'});
        this.header = header;
        this.icon = new St.Icon({
            gicon: iconFor(extensionPath, icon),
            style_class: 'resource-bar-card-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.title = new St.Label({
            text: title,
            style_class: 'resource-bar-card-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.value = new St.Label({
            text: '--',
            style_class: 'resource-bar-card-value',
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(this.icon);
        header.add_child(this.title);
        header.add_child(this.value);
        this.actor.add_child(header);

        this.lines = [0, 1].map(() => {
            const l = new St.Label({style_class: 'resource-bar-card-sub', opacity: 190});
            this.actor.add_child(l);
            return l;
        });
    }

    addGraph() {
        // Cards in a grid row share its height; anchoring the graph to the
        // bottom lines up graphs whose cards have different amounts of text.
        this.graph = new Graph({
            style_class: 'resource-bar-card-graph',
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.END,
        });
        this.actor.add_child(this.graph);
    }

    // Puts a control right after the title; the control takes the free space
    // but stays left-aligned, so the value keeps its place on the right.
    addHeaderControl(widget) {
        this.title.x_expand = false;
        widget.x_expand = true;
        widget.x_align = Clutter.ActorAlign.START;
        widget.y_align = Clutter.ActorAlign.CENTER;
        this.header.insert_child_above(widget, this.title);
    }

    addList() {
        this.list = new St.BoxLayout({orientation: VERTICAL, style_class: 'resource-bar-disk-list'});
        this.actor.add_child(this.list);
    }

    addCores() {
        this.cores = new CoreGauges('resource-bar-card-cores');
        this.cores.x_align = Clutter.ActorAlign.START;
        this.actor.add_child(this.cores);
    }

    setLines(a, b = '') {
        this.lines[0].text = a;
        this.lines[0].visible = a !== '';
        this.lines[1].text = b;
        this.lines[1].visible = b !== '';
    }

    setAccent(color, background) {
        const css = toCss(color);
        if (this._accent !== css) {
            this._accent = css;
            this.icon.set_style(`color: ${css};`);
            this.value.set_style(`color: ${css};`);
        }
        const bg = toCss(background);
        if (this._bg !== bg) {
            this._bg = bg;
            this.actor.set_style(`background-color: ${bg};`);
        }
    }
}

// Two-option pill switch ("Ocupação | Utilização").
class Segmented {
    constructor(options, onPick) {
        this.actor = new St.BoxLayout({style_class: 'resource-bar-seg'});
        this._buttons = options.map(([value, label]) => {
            const button = new St.Button({
                label,
                style_class: 'resource-bar-seg-btn',
                can_focus: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            button.connect('clicked', () => onPick(value));
            this.actor.add_child(button);
            return [value, button];
        });
    }

    setActive(value) {
        for (const [v, button] of this._buttons) {
            if (v === value)
                button.add_style_class_name('active');
            else
                button.remove_style_class_name('active');
        }
    }
}

// One line per disk: name, bar, percentage and details. In "space" mode the
// bar is the used space; in "activity" mode it is the time the disk spent
// reading or writing (like iostat %util), with read/write speeds.
class DiskRow {
    // Every column but the bar has a fixed width (see stylesheet), so the bar
    // is the same length in every row and both modes, whatever the numbers.
    constructor() {
        const label = (style, params = {}) => new St.Label({
            style_class: style,
            y_align: Clutter.ActorAlign.CENTER,
            ...params,
        });
        this.actor = new St.BoxLayout({style_class: 'resource-bar-disk-row', x_expand: true});
        this.name = label('resource-bar-disk-name');
        // Same column, one at a time: the usage bar (Ocupação) or the
        // activity history graph (Utilização).
        this.bar = new Gauge({styleClass: 'resource-bar-disk-bar', horizontal: true});
        this.bar.x_expand = true;
        this.graph = new Graph({style_class: 'resource-bar-disk-graph', x_expand: true, visible: false});
        this.pct = label('resource-bar-disk-pct');

        // Details column: "used / total" in Ocupação, or read and write
        // speeds in two right-aligned sub-columns in Utilização.
        this.details = new St.BoxLayout({style_class: 'resource-bar-disk-details', opacity: 190});
        this.usage = label('resource-bar-disk-usage', {x_expand: true});
        this.read = label('resource-bar-disk-rate');
        this.write = label('resource-bar-disk-rate');
        for (const child of [this.usage, this.read, this.write])
            this.details.add_child(child);

        for (const child of [this.name, this.bar, this.graph, this.pct, this.details])
            this.actor.add_child(child);
    }

    update(disk, color, animMs = 0) {
        this._showRates(false);
        this.bar.show();
        this.graph.hide();
        this.usage.text = formatUsage(disk.used, disk.used + disk.avail);
        this._set(disk.path, disk.pct, color, animMs);
    }

    // history: {values (0..1), count}; graphColor/background tint the graph.
    updateActivity(path, io, color, {history, graphColor, background}, animMs = 0) {
        this._showRates(true);
        this.bar.hide();
        this.graph.show();
        const rate = v => formatRate(v, {unit: 'auto'});
        this.read.text = io ? `↓ ${rate(io.read)}` : '↓ --';
        this.write.text = io ? `↑ ${rate(io.write)}` : '↑ --';
        this.graph.setSeries([{values: history.values, color: graphColor, count: history.count}],
            background, animMs);
        this._set(path, io ? io.util : null, color, animMs);
    }

    _showRates(rates) {
        this.usage.visible = !rates;
        this.read.visible = rates;
        this.write.visible = rates;
    }

    _set(path, pct, color, animMs) {
        this.name.text = mountName(path);
        this.pct.text = pct === null ? '--' : `${Math.round(pct)}%`;
        this.pct.set_style(`color: ${toCss(color)};`);
        this.bar.setColor(color);
        this.bar.setProgress((pct ?? 0) / 100, animMs);
    }
}

export class ResourcePopup {
    constructor(extension) {
        this._ext = extension;
        const path = extension.path;

        this.item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        this.item.add_style_class_name('resource-bar-popup-item');
        const root = new St.BoxLayout({orientation: VERTICAL, style_class: 'resource-bar-popup', x_expand: true});
        this.item.add_child(root);

        this._header = new St.Label({style_class: 'resource-bar-popup-header', opacity: 200});
        root.add_child(this._header);

        const grid = new Clutter.GridLayout({column_homogeneous: true});
        this._grid = new St.Widget({layout_manager: grid, style_class: 'resource-bar-grid', x_expand: true});
        root.add_child(this._grid);

        this._cards = {
            cpu: new Card('CPU', 'cpu', path),
            mem: new Card('Memória', 'memory', path),
            net: new Card('Rede', 'download', path),
            disk: new Card('Discos', 'disk', path),
            gpu: new Card('GPU', 'gpu', path),
        };
        this._cards.cpu.addCores();
        this._cards.cpu.addGraph();
        this._cards.mem.addGraph();
        this._cards.net.addGraph();
        this._cards.disk.addList();
        this._diskMode = new Segmented([['space', 'Ocupação'], ['activity', 'Utilização']],
            mode => extension.setDiskCardMode(mode));
        this._cards.disk.addHeaderControl(this._diskMode.actor);
        this._cards.gpu.addGraph();
        this._diskRows = [];
        this._diskSig = null;

        // CPU | Memória, Rede | GPU (Rede takes the row without a GPU),
        // then Discos across the full width.
        const hasGpu = extension._sampler?.hasGpu ?? false;
        grid.attach(this._cards.cpu.actor, 0, 0, 1, 1);
        grid.attach(this._cards.mem.actor, 1, 0, 1, 1);
        grid.attach(this._cards.net.actor, 0, 1, hasGpu ? 1 : 2, 1);
        if (hasGpu)
            grid.attach(this._cards.gpu.actor, 1, 1, 1, 1);
        grid.attach(this._cards.disk.actor, 0, 2, 2, 1);
    }

    // ctx: {snapshot, model, opts, thresholds, highlight, hasGpu, graphColors, accent, animMs,
    //       diskCardMode}
    refresh(ctx) {
        const {snapshot: s, model, opts, thresholds, highlight} = ctx;
        let base;
        try {
            const fg = this._header.get_theme_node().get_foreground_color();
            base = {r: fg.red / 255, g: fg.green / 255, b: fg.blue / 255, a: 1};
        } catch {
            base = {r: 1, g: 1, b: 1, a: 1};
        }
        const cardBg = withAlpha(base, 0.06);
        // The dropdown always shows full units, whatever the panel uses.
        const popupOpts = {...opts, showUnits: true, net: {...opts.net, compact: false}};
        // Only the history graphs follow the "graph-colors" setting; bars,
        // titles, icons and values keep the menu text color.
        const colorOf = id => {
            const r = model.evaluate(id, s, popupOpts, thresholds);
            const graphBase = graphBaseColor(ctx.graphColors, categoryOf(id), base, ctx.accent);
            return {
                r,
                color: mixColors(base, highlight, r.factor),
                graphColor: mixColors(graphBase, highlight, r.factor),
            };
        };
        const animMs = ctx.animMs ?? 0;
        const series = (id, color, fill = true) =>
            ({values: model.normalizedHistory(id, s), color, fill, count: model.count(id)});

        // Header
        if (s.system) {
            const load = s.system.load.map(v => v.toFixed(2)).join('  ');
            this._header.text = `Carga ${load}   ·   Ligado há ${formatDuration(s.system.uptime)}`;
        }

        // CPU
        {
            const card = this._cards.cpu;
            const {r, color, graphColor} = colorOf('cpu_usage');
            card.value.text = r.text;
            card.setAccent(color, cardBg);
            const parts = [];
            if (s.cpuTemp !== null)
                parts.push(`${Math.round(s.cpuTemp)}°C`);
            if (s.cpuFreq)
                parts.push(`${(s.cpuFreq.mhz / 1000).toFixed(2)} GHz`);
            parts.push(`${s.cpu.cores.length} núcleos`);
            card.setLines(parts.join('  ·  '));
            const [a, c] = thresholds.cpu_usage;
            card.cores.update(s.cpu.cores, v => mixColors(base, highlight, gradientFactor(v, a, c)), animMs);
            card.graph.setSeries([series('cpu_usage', graphColor)], withAlpha(base, 0.05), animMs);
        }

        // Memory
        {
            const card = this._cards.mem;
            const {r, color, graphColor} = colorOf('ram_pct');
            card.value.text = r.text;
            card.setAccent(color, cardBg);
            if (s.mem) {
                const swap = s.mem.swapTotal > 0
                    ? `Swap ${Math.round(s.mem.swapPct)}%  ·  ${formatUsage(s.mem.swapUsed, s.mem.swapTotal)}`
                    : 'Sem swap';
                card.setLines(`${formatUsage(s.mem.used, s.mem.total)}`, swap);
            }
            card.graph.setSeries([series('ram_pct', graphColor)], withAlpha(base, 0.05), animMs);
        }

        // Network
        {
            const card = this._cards.net;
            const rx = colorOf('net_rx');
            const tx = colorOf('net_tx');
            const rate = v => formatRate(v, {unit: opts.net.unit});
            card.value.text = s.net ? `↓ ${rate(s.net.rx)}` : '--';
            card.setAccent(rx.color, cardBg);
            card.setLines(s.net ? `↑ ${rate(s.net.tx)}` : '', opts.iface ? `Interface ${opts.iface}` : 'Interfaces físicas');
            card.graph.setSeries([
                series('net_rx', rx.graphColor),
                series('net_tx', withAlpha(tx.graphColor, 0.55), false),
            ], withAlpha(base, 0.05), animMs);
        }

        // Disks
        {
            const card = this._cards.disk;
            const list = s.diskList ?? [];
            const sig = list.map(d => d.path).join('\n');
            if (sig !== this._diskSig) {
                this._diskSig = sig;
                card.list.destroy_all_children();
                this._diskRows = list.map(() => {
                    const row = new DiskRow();
                    card.list.add_child(row.actor);
                    return row;
                });
            }
            const activity = ctx.diskCardMode === 'activity';
            this._diskMode.setActive(activity ? 'activity' : 'space');
            const [a, c] = activity ? thresholds.disk_io : thresholds.disk;
            let worst = 0;
            list.forEach((m, i) => {
                if (activity) {
                    const io = s.diskIo?.[m.ioName];
                    const factor = io ? gradientFactor(io.util, a, c) : 0;
                    worst = Math.max(worst, factor);
                    const key = diskUtilKey(m.path);
                    const graphBase = graphBaseColor(ctx.graphColors, 'disk', base, ctx.accent);
                    this._diskRows[i].updateActivity(m.path, io, mixColors(base, highlight, factor), {
                        history: {values: model.normalizedHistory(key, s), count: model.count(key)},
                        graphColor: mixColors(graphBase, highlight, factor),
                        background: withAlpha(base, 0.05),
                    }, animMs);
                } else {
                    const d = s.disks[m.path];
                    const factor = gradientFactor(d.pct, a, c);
                    worst = Math.max(worst, factor);
                    this._diskRows[i].update(d, mixColors(base, highlight, factor), animMs);
                }
            });
            card.value.text = list.length === 1 ? '1 disco' : `${list.length} discos`;
            card.setAccent(mixColors(base, highlight, worst), cardBg);
            card.setLines(list.length === 0 ? 'Calculando…' : '');
        }

        // GPU
        {
            const card = this._cards.gpu;
            card.actor.visible = ctx.hasGpu;
            if (ctx.hasGpu) {
                const {r, color, graphColor} = colorOf('gpu_usage');
                card.value.text = r.text;
                card.setAccent(color, cardBg);
                const g = s.gpu;
                if (g?.suspended) {
                    card.setLines('Em suspensão (economia de energia)');
                } else if (g) {
                    const parts = [];
                    if (g.temp !== null)
                        parts.push(`${Math.round(g.temp)}°C`);
                    if (g.vramUsed !== null && g.vramTotal)
                        parts.push(`VRAM ${formatUsage(g.vramUsed, g.vramTotal)}`);
                    card.title.text = shortGpuName(g.name);
                    card.setLines(parts.join('  ·  '));
                } else {
                    card.setLines('Aguardando dados…');
                }
                card.graph.setSeries([series('gpu_usage', graphColor)], withAlpha(base, 0.05), animMs);
            }
        }
    }

    destroy() {
        this.item.destroy();
    }
}

// "NVIDIA GeForce RTX 4080 SUPER" -> "RTX 4080 SUPER" so it fits half a row.
function shortGpuName(name) {
    if (!name || name === 'GPU')
        return 'GPU';
    return name.replace(/^(NVIDIA|AMD|Intel(\(R\))?)\s+/i, '').replace(/^(GeForce|Radeon)\s+/i, '');
}
