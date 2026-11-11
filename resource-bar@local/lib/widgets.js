// St widgets: vertical gauge pill, per-core gauges, sparkline graph and the
// stat item (icon + visualization + value) shown in the top bar.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';

import {HISTORY_SIZE} from './stats.js';
import {toCss, withAlpha} from './color.js';

const ANIMATION_MS = 250;

export function iconFor(extensionPath, name) {
    return Gio.icon_new_for_string(`${extensionPath}/icons/${name}-symbolic.svg`);
}

function setStyleCached(actor, key, style) {
    if (actor[key] === style)
        return;
    actor[key] = style;
    actor.set_style(style);
}

// Vertical (or horizontal) pill: dimmed track + fill growing from the bottom
// (or the left). Size comes from CSS; the fill is placed in vfunc_allocate and
// the eased "progress" property animates it.
export const Gauge = GObject.registerClass({
    Properties: {
        'progress': GObject.ParamSpec.double('progress', null, null,
            GObject.ParamFlags.READWRITE, 0, 1, 0),
    },
}, class ResourceBarGauge extends St.Widget {
    _init({styleClass = 'resource-bar-gauge', horizontal = false} = {}) {
        super._init({style_class: styleClass, y_align: Clutter.ActorAlign.CENTER});
        this._horizontal = horizontal;
        this._progress = 0;
        this._fill = new St.Widget({style_class: `${styleClass}-fill`});
        this.add_child(this._fill);
    }

    get progress() {
        return this._progress;
    }

    set progress(value) {
        const p = Math.min(1, Math.max(0, value || 0));
        if (p === this._progress)
            return;
        this._progress = p;
        this.notify('progress');
        this.queue_relayout();
    }

    setProgress(progress, animate = true) {
        const p = Math.min(1, Math.max(0, progress || 0));
        this.remove_transition('progress');
        if (animate && this.mapped && Math.abs(p - this._progress) > 0.001) {
            this.ease_property('progress', p, {
                duration: ANIMATION_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        } else {
            this.progress = p;
        }
    }

    setColor(color) {
        setStyleCached(this, '_rbStyle', `background-color: ${toCss(withAlpha(color, 0.3))};`);
        setStyleCached(this._fill, '_rbStyle', `background-color: ${toCss(color)};`);
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const content = this.get_theme_node().get_content_box(box);
        const w = content.get_width();
        const h = content.get_height();
        const child = new Clutter.ActorBox();
        if (this._horizontal) {
            child.set_origin(content.x1, content.y1);
            child.set_size(Math.round(w * this._progress), h);
        } else {
            const fillH = Math.round(h * this._progress);
            child.set_origin(content.x1, content.y2 - fillH);
            child.set_size(w, fillH);
        }
        this._fill.allocate(child);
    }
});

// One thin gauge per CPU core.
export const CoreGauges = GObject.registerClass(
class ResourceBarCoreGauges extends St.BoxLayout {
    _init(styleClass = 'resource-bar-cores') {
        super._init({style_class: styleClass, y_align: Clutter.ActorAlign.CENTER});
        this._gauges = [];
    }

    update(cores, colorFor) {
        if (cores.length !== this._gauges.length) {
            this.destroy_all_children();
            this._gauges = cores.map(() => {
                const g = new Gauge({styleClass: 'resource-bar-core-gauge'});
                this.add_child(g);
                return g;
            });
        }
        cores.forEach((usage, i) => {
            this._gauges[i].setColor(colorFor(usage));
            this._gauges[i].setProgress(usage / 100);
        });
    }
});

// Sparkline: filled area + line. Supports several series (popup network card).
export const Graph = GObject.registerClass(
class ResourceBarGraph extends St.DrawingArea {
    _init(params = {}) {
        super._init({style_class: 'resource-bar-graph', y_align: Clutter.ActorAlign.CENTER, ...params});
        this._series = [];
        this._background = null;
    }

    // series: [{values: number[0..1], color: {r,g,b,a}, fill: bool}]
    setSeries(series, background = null) {
        this._series = series;
        this._background = background;
        this.queue_repaint();
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
        const radius = Math.min(h / 2, 4 * scale);

        const roundRect = () => {
            cr.newSubPath();
            cr.arc(w - radius, radius, radius, -Math.PI / 2, 0);
            cr.arc(w - radius, h - radius, radius, 0, Math.PI / 2);
            cr.arc(radius, h - radius, radius, Math.PI / 2, Math.PI);
            cr.arc(radius, radius, radius, Math.PI, 1.5 * Math.PI);
            cr.closePath();
        };

        roundRect();
        cr.clip();
        if (this._background) {
            const b = this._background;
            cr.setSourceRGBA(b.r, b.g, b.b, b.a);
            cr.paint();
        }

        const lineWidth = Math.max(1, scale);
        const pad = lineWidth;
        const step = w / (HISTORY_SIZE - 1);
        for (const {values, color, fill = true} of this._series) {
            if (!values || values.length === 0)
                continue;
            const pts = values.map((v, i) => [
                w - (values.length - 1 - i) * step,
                h - pad - v * (h - 2 * pad),
            ]);
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
        }
    }
});

// Icon + (gauge | per-core gauges | graph) + value label.
export const StatItem = GObject.registerClass(
class ResourceBarStatItem extends St.BoxLayout {
    _init(statId, def, config, extensionPath) {
        super._init({
            style_class: config.capsule ? 'resource-bar-item capsule' : 'resource-bar-item',
            y_align: Clutter.ActorAlign.CENTER,
            accessible_name: def.name,
        });
        this.statId = statId;
        this._config = config;

        if (config.showIcon) {
            this._icon = new St.Icon({
                gicon: iconFor(extensionPath, def.icon),
                style_class: 'resource-bar-icon',
                y_align: Clutter.ActorAlign.CENTER,
            });
            this.add_child(this._icon);
        }

        if (config.visualization === 'gauge') {
            this._vis = statId === 'cpu_usage' && config.showCpuCores ? new CoreGauges() : new Gauge();
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

    // ctx: {result, color, colorFor(value), history(): number[], cores, capsuleBg}
    update(ctx) {
        const {result, color} = ctx;
        const css = toCss(color);
        if (this._icon)
            setStyleCached(this._icon, '_rbStyle', `color: ${css};`);
        if (this._label) {
            if (this._label.text !== result.text)
                this._label.text = result.text;
            const minWidth = this._config.labelMinWidth > 0 ? `min-width: ${this._config.labelMinWidth}px; ` : '';
            setStyleCached(this._label, '_rbStyle', `${minWidth}color: ${css};`);
        }
        if (this._config.capsule && ctx.capsuleBg)
            setStyleCached(this, '_rbStyle', `background-color: ${toCss(ctx.capsuleBg)};`);

        if (this._vis instanceof CoreGauges) {
            this._vis.update(ctx.cores, ctx.colorFor);
        } else if (this._vis instanceof Gauge) {
            this._vis.setColor(color);
            this._vis.setProgress(result.norm);
        } else if (this._vis instanceof Graph) {
            this._vis.setSeries([{values: ctx.history(), color}], withAlpha(color, 0.12));
        }
    }
});
