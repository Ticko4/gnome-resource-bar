// Dropdown content: header with load/uptime and a grid of cards (CPU,
// memory, network, disk, GPU), each with value, details and a history graph.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {formatBytes, formatDuration, formatRate, formatUsage, gradientFactor} from './stats.js';
import {mixColors, toCss, withAlpha} from './color.js';
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
        this.graph = new Graph({style_class: 'resource-bar-card-graph', x_expand: true});
        this.actor.add_child(this.graph);
    }

    addBar() {
        this.bar = new Gauge({styleClass: 'resource-bar-card-bar', horizontal: true});
        this.bar.x_expand = true;
        this.actor.add_child(this.bar);
    }

    addCores() {
        this.cores = new CoreGauges('resource-bar-card-cores');
        this.cores.x_align = Clutter.ActorAlign.FILL;
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
            disk: new Card('Disco', 'disk', path),
            gpu: new Card('GPU', 'gpu', path),
        };
        this._cards.cpu.addCores();
        this._cards.cpu.addGraph();
        this._cards.mem.addGraph();
        this._cards.net.addGraph();
        this._cards.disk.addBar();
        this._cards.gpu.addGraph();

        grid.attach(this._cards.cpu.actor, 0, 0, 1, 1);
        grid.attach(this._cards.mem.actor, 1, 0, 1, 1);
        grid.attach(this._cards.net.actor, 0, 1, 1, 1);
        grid.attach(this._cards.disk.actor, 1, 1, 1, 1);
        grid.attach(this._cards.gpu.actor, 0, 2, 2, 1);
    }

    // ctx: {snapshot, model, opts, thresholds, highlight}
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
        const colorOf = id => {
            const r = model.evaluate(id, s, popupOpts, thresholds);
            return {r, color: mixColors(base, highlight, r.factor)};
        };
        const series = (id, color, fill = true) => ({values: model.normalizedHistory(id, s), color, fill});

        // Header
        if (s.system) {
            const load = s.system.load.map(v => v.toFixed(2)).join('  ');
            this._header.text = `Carga ${load}   ·   Ligado há ${formatDuration(s.system.uptime)}`;
        }

        // CPU
        {
            const card = this._cards.cpu;
            const {r, color} = colorOf('cpu_usage');
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
            card.cores.update(s.cpu.cores, v => mixColors(base, highlight, gradientFactor(v, a, c)));
            card.graph.setSeries([series('cpu_usage', color)], withAlpha(base, 0.05));
        }

        // Memory
        {
            const card = this._cards.mem;
            const {r, color} = colorOf('ram_pct');
            card.value.text = r.text;
            card.setAccent(color, cardBg);
            if (s.mem) {
                const swap = s.mem.swapTotal > 0
                    ? `Swap ${Math.round(s.mem.swapPct)}%  ·  ${formatUsage(s.mem.swapUsed, s.mem.swapTotal)}`
                    : 'Sem swap';
                card.setLines(`${formatUsage(s.mem.used, s.mem.total)}`, swap);
            }
            card.graph.setSeries([series('ram_pct', color)], withAlpha(base, 0.05));
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
                series('net_rx', rx.color),
                series('net_tx', withAlpha(tx.color, 0.55), false),
            ], withAlpha(base, 0.05));
        }

        // Disk
        {
            const card = this._cards.disk;
            const {r, color} = colorOf('disk_used_pct');
            card.value.text = r.text;
            card.setAccent(color, cardBg);
            if (s.disk) {
                card.setLines(formatUsage(s.disk.used, s.disk.used + s.disk.avail),
                    `${formatBytes(s.disk.avail)} livres em ${s.disk.path}`);
            } else {
                card.setLines('Calculando…');
            }
            card.bar.setColor(color);
            card.bar.setProgress(r.norm);
        }

        // GPU
        {
            const card = this._cards.gpu;
            card.actor.visible = ctx.hasGpu;
            if (ctx.hasGpu) {
                const {r, color} = colorOf('gpu_usage');
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
                    card.title.text = g.name && g.name !== 'GPU' ? g.name : 'GPU';
                    card.setLines(parts.join('  ·  '));
                } else {
                    card.setLines('Aguardando dados…');
                }
                card.graph.setSeries([series('gpu_usage', color)], withAlpha(base, 0.05));
            }
        }
    }

    destroy() {
        this.item.destroy();
    }
}
