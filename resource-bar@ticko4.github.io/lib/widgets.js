// St widgets: vertical gauge pill, per-core gauges, sparkline graph and the
// stat item (icon + visualization + value) shown in the top bar.
//
// Gauges and graphs glide between samples instead of jumping: each new value
// starts an animation lasting about one sampling interval, driven by the
// actor's frame clock and capped at ~30 fps.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {HISTORY_KEEP, HISTORY_SIZE, STATS, parseKey} from './stats.js';
import {mountName} from './mounts.js';
import {toCss, withAlpha} from './color.js';

const FRAME_INTERVAL_US = 30000;

const clamp01 = v => Math.min(1, Math.max(0, v || 0));

// Changes smaller than this many pixels jump instead of animating, so stable
// metrics do not keep the compositor redrawing the panel.
const MIN_ANIMATED_PX = 0.25;

export function iconFor(extensionPath, name) {
    return Gio.icon_new_for_string(`${extensionPath}/icons/${name}-symbolic.svg`);
}

function setStyleCached(actor, key, style) {
    if (actor[key] === style)
        return;
    actor[key] = style;
    actor.set_style(style);
}

// Rounded-rectangle path with corner radius r (clamped to fit).
function roundedRect(cr, w, h, r, x = 0, y = 0) {
    r = Math.min(r, w / 2, h / 2);
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

// Pill track (fill color dimmed, like Noctalia) plus a fill rectangle clipped
// to the pill, so even one or two pixels of fill keep the rounded end.
function drawPill(cr, x, y, w, h, progress, c, horizontal) {
    cr.save();
    roundedRect(cr, w, h, Math.min(w, h) / 2, x, y);
    cr.setSourceRGBA(c.r, c.g, c.b, c.a * 0.3);
    cr.fillPreserve();
    cr.clip();
    if (horizontal)
        cr.rectangle(x, y, w * progress, h);
    else
        cr.rectangle(x, y + h - h * progress, w, h * progress);
    cr.setSourceRGBA(c.r, c.g, c.b, c.a);
    cr.fill();
    cr.restore();
}

// Runs onFrame(progress 0..1) over durationMs on the actor's frame clock, at
// most ~30 times per second (plenty for motion this slow; each frame makes
// the compositor repaint the panel), and always finishes with onFrame(1). A
// zero duration, disabled animations (GNOME "Reduce animation") or an
// unmapped actor jump straight to the end.
class Animator {
    constructor(actor, onFrame) {
        this._actor = actor;
        this._onFrame = onFrame;
        this._timeline = null;
        this._lastFrame = 0;
        actor.connect('destroy', () => this.stop());
    }

    get running() {
        return this._timeline !== null;
    }

    start(durationMs) {
        this.stop();
        if (!(durationMs > 0) || !St.Settings.get().enable_animations || !this._actor.mapped) {
            this._onFrame(1);
            return;
        }
        const timeline = new Clutter.Timeline({actor: this._actor, duration: durationMs});
        timeline.connect('new-frame', () => {
            const now = GLib.get_monotonic_time();
            if (now - this._lastFrame < FRAME_INTERVAL_US)
                return;
            this._lastFrame = now;
            this._onFrame(timeline.get_progress());
        });
        timeline.connect('completed', () => {
            if (this._timeline === timeline)
                this._timeline = null;
            this._onFrame(1);
        });
        this._timeline = timeline;
        this._onFrame(0);
        timeline.start();
    }

    stop() {
        const timeline = this._timeline;
        this._timeline = null;
        timeline?.stop();
    }
}

// Vertical (or horizontal) pill gauge. Size comes from CSS.
export const Gauge = GObject.registerClass(
class ResourceBarGauge extends St.DrawingArea {
    _init({styleClass = 'resource-bar-gauge', horizontal = false} = {}) {
        super._init({style_class: styleClass, y_align: Clutter.ActorAlign.CENTER});
        this._horizontal = horizontal;
        this._from = 0;
        this._to = 0;
        this._shown = 0;
        this._color = {r: 1, g: 1, b: 1, a: 1};
        this._anim = new Animator(this, t => {
            this._shown = this._from + (this._to - this._from) * t;
            this.queue_repaint();
        });
    }

    get progress() {
        return this._shown;
    }

    // Glides from the value on screen to `progress` over durationMs (0 = jump).
    setProgress(progress, durationMs = 0) {
        const p = clamp01(progress);
        if (Math.abs(p - this._to) < 0.0005 && (this._anim.running || p === this._shown))
            return;
        // Allocation size: get_surface_size() is only valid inside repaint.
        const box = this.get_allocation_box();
        const extent = this._horizontal ? box.get_width() : box.get_height();
        this._from = this._shown;
        this._to = p;
        this._anim.start(Math.abs(p - this._shown) * extent < MIN_ANIMATED_PX ? 0 : durationMs);
    }

    setColor(color) {
        const css = toCss(color);
        if (this._colorCss === css)
            return;
        this._colorCss = css;
        this._color = color;
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        try {
            const [w, h] = this.get_surface_size();
            if (w > 0 && h > 0)
                drawPill(cr, 0, 0, w, h, this._shown, this._color, this._horizontal);
        } finally {
            cr.$dispose();
        }
    }
});

// One thin pill per CPU core, drawn in a single surface (one repaint per
// frame instead of one per core). Bar width and gap come from the CSS
// properties -bar-width and -bar-spacing.
export const CoreGauges = GObject.registerClass(
class ResourceBarCoreGauges extends St.DrawingArea {
    _init(styleClass = 'resource-bar-cores') {
        super._init({style_class: styleClass, y_align: Clutter.ActorAlign.CENTER});
        this._from = [];
        this._to = [];
        this._shown = [];
        this._colors = [];
        this._anim = new Animator(this, t => {
            this._shown = this._to.map((v, i) => this._from[i] + (v - this._from[i]) * t);
            this.queue_repaint();
        });
    }

    update(cores, colorFor, durationMs = 0) {
        const targets = cores.map(v => clamp01(v / 100));
        this._colors = cores.map(colorFor);
        if (targets.length !== this._to.length) {
            this._shown = targets.map(() => 0);
            this.queue_relayout();
        } else if (targets.every((v, i) => Math.abs(v - this._to[i]) < 0.0005)) {
            this.queue_repaint();
            return;
        }
        const h = this.get_allocation_box().get_height();
        const moves = targets.some((v, i) => Math.abs(v - (this._shown[i] ?? 0)) * h >= MIN_ANIMATED_PX);
        this._from = [...this._shown];
        this._to = targets;
        this._anim.start(moves ? durationMs : 0);
    }

    _metrics() {
        const node = this.get_theme_node();
        return [node.get_length('-bar-width') || 3, node.get_length('-bar-spacing')];
    }

    vfunc_get_preferred_width(_forHeight) {
        const n = this._to.length;
        const [bar, gap] = this._metrics();
        const width = n > 0 ? n * bar + (n - 1) * gap : 0;
        return this.get_theme_node().adjust_preferred_width(width, width);
    }

    vfunc_repaint() {
        const cr = this.get_context();
        try {
            const [, h] = this.get_surface_size();
            const [bar, gap] = this._metrics();
            this._shown.forEach((p, i) => {
                const c = this._colors[i] ?? {r: 1, g: 1, b: 1, a: 1};
                drawPill(cr, i * (bar + gap), 0, bar, h, p, c, false);
            });
        } finally {
            cr.$dispose();
        }
    }
});

// Sparkline: filled area + line, several series allowed (popup network card).
// With a duration, each new sample scrolls in from the right edge over that
// time and rescaled history (e.g. a new network peak) eases to its new height.
export const Graph = GObject.registerClass(
class ResourceBarGraph extends St.DrawingArea {
    _init(params = {}) {
        super._init({style_class: 'resource-bar-graph', y_align: Clutter.ActorAlign.CENTER, ...params});
        this._series = [];
        this._fromY = null;     // per series: height each point starts from
        this._fromOffset = 0;   // in steps; the scroll glides from here to 0
        this._t = 1;
        this._count = null;
        this._background = null;
        this._anim = new Animator(this, t => {
            this._t = t;
            this.queue_repaint();
        });
    }

    // Heights of series k as drawn at animation progress t.
    _shownValues(k, t) {
        const values = this._series[k]?.values ?? [];
        const from = this._fromY?.[k];
        return values.map((v, i) => (from?.[i] !== undefined ? from[i] + (v - from[i]) * t : v));
    }

    // series: [{values: number[0..1], color: {r,g,b,a}, fill: bool, count}]
    // count is the total number of samples pushed so far for that history; it
    // tells a new sample (count + 1) from a plain refresh (same count).
    setSeries(series, background = null, durationMs = 0) {
        this._background = background;
        const count = series[0]?.count ?? null;
        const delta = count !== null && this._count !== null && series.length === this._series.length
            ? count - this._count : -1;

        if (delta === 0) {
            // Same samples (settings change, menu reopened): keep animating.
            this._series = series;
            this.queue_repaint();
            return;
        }
        if (delta === 1 && durationMs > 0) {
            // Continue from exactly what is on screen (even mid-animation):
            // each point starts at its drawn height and the scroll offset
            // grows by one step for the new sample, so motion never restarts.
            const t = this._t;
            const shown = this._series.map((_s, k) => this._shownValues(k, t));
            const offsetNow = this._fromOffset * (1 - t);
            this._fromY = series.map((s, k) => {
                const old = shown[k] ?? [];
                const n = s.values.length;
                const m = old.length;
                return s.values.map((_v, i) => old[i + m - n + 1]);
            });
            // Capped at the two extra samples kept beyond the visible width.
            this._fromOffset = Math.min(offsetNow + 1, HISTORY_KEEP - HISTORY_SIZE);
        } else {
            this._fromY = null;
            this._fromOffset = 0;
        }
        this._series = series;
        this._count = count;
        this._anim.start(this._fromY ? durationMs : 0);
    }

    vfunc_repaint() {
        const cr = this.get_context();
        try {
            this._draw(cr);
        } finally {
            cr.$dispose();
        }
    }

    _draw(cr) {
        const [w, h] = this.get_surface_size();
        if (w <= 0 || h <= 0)
            return;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;

        roundedRect(cr, w, h, 4 * scale);
        cr.clip();
        if (this._background) {
            const b = this._background;
            cr.setSourceRGBA(b.r, b.g, b.b, b.a);
            cr.paint();
        }

        const lineWidth = Math.max(1, scale);
        const pad = lineWidth;
        const step = w / (HISTORY_SIZE - 1);
        const t = this._t;
        // While animating, the newest point sits past the right edge and the
        // whole line slides left until the offset reaches zero.
        const offset = step * this._fromOffset * (1 - t);

        this._series.forEach(({color, fill = true}, k) => {
            const values = this._shownValues(k, t);
            if (values.length === 0)
                return;
            const n = values.length;
            const pts = values.map((y, i) =>
                [w - (n - 1 - i) * step + offset, h - pad - y * (h - 2 * pad)]);
            if (pts.length === 1)
                pts.unshift([pts[0][0] - step, pts[0][1]]);

            if (fill) {
                cr.moveTo(pts[0][0], h);
                for (const [x, y] of pts)
                    cr.lineTo(x, y);
                cr.lineTo(pts[pts.length - 1][0], h);
                cr.closePath();
                cr.setSourceRGBA(color.r, color.g, color.b, color.a * 0.28);
                cr.fill();
            }

            cr.moveTo(pts[0][0], pts[0][1]);
            for (const [x, y] of pts.slice(1))
                cr.lineTo(x, y);
            cr.setSourceRGBA(color.r, color.g, color.b, color.a);
            cr.setLineWidth(lineWidth);
            cr.setLineJoin(1); // ROUND
            cr.setLineCap(1); // ROUND
            cr.stroke();
        });
    }
});

// Icon + optional disk name + (gauge | per-core gauges | graph) + value label.
export const StatItem = GObject.registerClass(
class ResourceBarStatItem extends St.BoxLayout {
    _init(statKey, config, extensionPath) {
        const {id, param} = parseKey(statKey);
        const def = STATS[id];
        super._init({
            style_class: 'resource-bar-item',
            y_align: Clutter.ActorAlign.CENTER,
            accessible_name: param ? `${_(def.name)} ${param}` : _(def.name),
        });
        this.statKey = statKey;
        this._config = config;

        if (config.showIcon) {
            this._icon = new St.Icon({
                gicon: iconFor(extensionPath, def.icon),
                style_class: 'resource-bar-icon',
                y_align: Clutter.ActorAlign.CENTER,
            });
            this.add_child(this._icon);
        }

        // Items pinned to a disk show its short name ("KIOXIA-SSD") so
        // several disks can sit side by side in the panel.
        if (param) {
            this._tag = new St.Label({
                text: mountName(param),
                style_class: 'resource-bar-tag',
                y_align: Clutter.ActorAlign.CENTER,
            });
            this.add_child(this._tag);
        }

        if (config.visualization === 'gauge') {
            this._vis = id === 'cpu_usage' && config.showCpuCores ? new CoreGauges() : new Gauge();
            this.add_child(this._vis);
        } else if (config.visualization === 'graph') {
            this._vis = new Graph();
            this.add_child(this._vis);
        }

        if (config.showValue) {
            this._label = new St.Label({
                style_class: 'resource-bar-value',
                y_align: Clutter.ActorAlign.CENTER,
                text: '--',
            });
            if (config.labelMinWidth > 0)
                this._label.set_style(`min-width: ${config.labelMinWidth}px;`);
            this.add_child(this._label);
        }
    }

    // Width reserved for the value, in logical px: grows at once but only
    // shrinks after the text has stayed narrower for 10 s, so items next to
    // a changing value ("9%" -> "10%", "1.2 kB/s" -> "12.5 kB/s") do not
    // shift sideways every second.
    _stableWidth() {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const [, natural] = this._label.clutter_text.get_preferred_width(-1);
        const width = Math.ceil(natural / scale);
        const now = GLib.get_monotonic_time();
        if (width >= (this._widthMax ?? 0) || now - this._widthMaxAt > 10e6) {
            this._widthMax = width;
            this._widthMaxAt = now;
        }
        return Math.max(this._config.labelMinWidth, this._widthMax);
    }

    // ctx: {result, color, graphColor, colorFor(value), history(): number[],
    //       historyCount, cores, animMs}
    // color tints icon/name/value and gauges; graphColor tints the graph;
    // animMs is how long gauges and graphs glide to the new sample.
    update(ctx) {
        const {result, color} = ctx;
        const graphColor = ctx.graphColor ?? color;
        const css = toCss(color);
        if (this._icon)
            setStyleCached(this._icon, '_rbStyle', `color: ${css};`);
        if (this._tag)
            setStyleCached(this._tag, '_rbStyle', `color: ${css};`);
        if (this._label) {
            if (this._label.text !== result.text)
                this._label.text = result.text;
            setStyleCached(this._label, '_rbStyle', `min-width: ${this._stableWidth()}px; color: ${css};`);
        }

        if (this._vis instanceof CoreGauges) {
            this._vis.update(ctx.cores, ctx.colorFor, ctx.animMs);
        } else if (this._vis instanceof Gauge) {
            this._vis.setColor(color);
            this._vis.setProgress(result.norm, ctx.animMs);
        } else if (this._vis instanceof Graph) {
            this._vis.setSeries([{values: ctx.history(), color: graphColor, count: ctx.historyCount}],
                withAlpha(graphColor, 0.12), ctx.animMs);
        }
    }
});
