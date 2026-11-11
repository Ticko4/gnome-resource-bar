// Resource Bar — GNOME Shell extension inspired by Noctalia Shell's sysmon
// bar widget: one compact item per stat (icon + gauge/graph + value) that
// tints toward a highlight color as the value crosses its thresholds.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Sampler} from './lib/sampler.js';
import {STATS, StatModel, THRESHOLDS, gradientFactor, sourcesFor} from './lib/stats.js';
import {WHITE, fromCogl, mixColors, parseColor, withAlpha} from './lib/color.js';
import {StatItem, iconFor} from './lib/widgets.js';
import {ResourcePopup} from './lib/popup.js';

const DEFAULT_HIGHLIGHT = '#FD4663';

const MONITOR_APPS = [
    'net.nokyan.Resources.desktop',
    'io.missioncenter.MissionCenter.desktop',
    'org.gnome.SystemMonitor.desktop',
    'gnome-system-monitor.desktop',
];

const REBUILD_KEYS = new Set([
    'stats', 'visualization', 'show-icon', 'show-value', 'show-units',
    'show-cpu-cores', 'label-min-width', 'use-capsule', 'spacing',
]);

function findMonitorApp() {
    const appSystem = Shell.AppSystem.get_default();
    for (const id of MONITOR_APPS) {
        const app = appSystem.lookup_app(id);
        if (app)
            return app;
    }
    return null;
}

function loadThresholds(settings) {
    const stored = settings.get_value('thresholds').deepUnpack();
    const out = {};
    for (const [key, def] of Object.entries(THRESHOLDS)) {
        const t = stored[key];
        out[key] = Array.isArray(t) && t.length === 2 ? [Number(t[0]), Number(t[1])] : def.defaults;
    }
    return out;
}

const ResourceIndicator = GObject.registerClass(
class ResourceIndicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.5, 'Resource Bar', false);
        this._ext = ext;
        this._items = [];
        this._base = WHITE;
        this.add_style_class_name('resource-bar-button');

        this._box = new St.BoxLayout({style_class: 'resource-bar-box', y_align: Clutter.ActorAlign.CENTER});
        this.add_child(this._box);

        this.popup = new ResourcePopup(ext);
        this.menu.addMenuItem(this.popup.item);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const monitor = findMonitorApp();
        if (monitor) {
            this.menu.addAction(`Abrir ${monitor.get_name()}`, () => monitor.activate(),
                iconFor(ext.path, 'cpu'));
        }
        this.menu.addAction('Configurações', () => ext.openPreferences(), 'preferences-system-symbolic');
        this.menu.connect('open-state-changed', (_menu, open) => ext.onMenuOpenChanged(open));

        this.connect('style-changed', () => this._syncBaseColor());
    }

    _syncBaseColor() {
        if (!this.get_stage())
            return;
        this._base = fromCogl(this.get_theme_node().get_foreground_color());
    }

    rebuild(config) {
        this._box.destroy_all_children();
        this._items = [];
        this._box.set_style(`spacing: ${config.spacing}px;`);
        for (const id of config.stats) {
            if (!STATS[id])
                continue;
            const item = new StatItem(id, STATS[id], config, this._ext.path);
            this._box.add_child(item);
            this._items.push(item);
        }
        if (this._items.length === 0) {
            // Keep something clickable so the menu and settings stay reachable.
            this._box.add_child(new St.Icon({
                gicon: iconFor(this._ext.path, 'cpu'),
                style_class: 'system-status-icon',
            }));
        }
    }

    refresh(ctx) {
        const {snapshot, model, opts, thresholds, highlight} = ctx;
        const base = this._base;
        for (const item of this._items) {
            const id = item.statId;
            const result = model.evaluate(id, snapshot, opts, thresholds);
            const [activity, critical] = thresholds[STATS[id].threshold];
            item.update({
                result,
                color: mixColors(base, highlight, result.factor),
                colorFor: v => mixColors(base, highlight, gradientFactor(v, activity, critical)),
                history: () => model.normalizedHistory(id, snapshot),
                cores: snapshot.cpu.cores,
                capsuleBg: withAlpha(base, 0.1),
            });
        }
    }

    _onDestroy() {
        this.popup = null;
        super._onDestroy();
    }
});

export default class ResourceBarExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._sampler = new Sampler();
        this._model = new StatModel();
        this._menuOpen = false;

        this._loadConfig();
        this._createIndicator();
        this._settingsChangedId = this._settings.connect('changed', (_s, key) => this._onSettingChanged(key));
        this._restartTimer();
        this._tick();
    }

    disable() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }
        this._indicator?.destroy();
        this._indicator = null;
        this._sampler?.destroy();
        this._sampler = null;
        this._model = null;
        this._settings = null;
    }

    _loadConfig() {
        const s = this._settings;
        const config = {
            stats: s.get_strv('stats').filter(id => STATS[id]),
            visualization: s.get_string('visualization'),
            showIcon: s.get_boolean('show-icon'),
            showValue: s.get_boolean('show-value'),
            showCpuCores: s.get_boolean('show-cpu-cores'),
            labelMinWidth: s.get_int('label-min-width'),
            capsule: s.get_boolean('use-capsule'),
            spacing: s.get_int('spacing'),
        };
        // Like Noctalia: icon, value and visualization cannot all be hidden.
        if (!config.showIcon && !config.showValue && config.visualization === 'none')
            config.showValue = true;
        this._config = config;

        this._opts = {
            showUnits: s.get_boolean('show-units'),
            iface: s.get_string('network-interface'),
            net: {
                unit: s.get_string('network-speed-unit'),
                compact: s.get_boolean('network-speed-compact'),
                decimals: s.get_int('network-speed-decimals'),
            },
        };
        this._highlight = parseColor(s.get_string('highlight-color'), parseColor(DEFAULT_HIGHLIGHT));
        this._thresholds = loadThresholds(s);
        this._sampler.setOptions({
            diskPath: s.get_string('disk-path'),
            networkInterface: s.get_string('network-interface'),
            interval: this._intervalMs(),
        });
        this._syncSources();
    }

    _intervalMs() {
        return Math.round(Math.max(0.5, this._settings.get_double('update-interval')) * 1000);
    }

    _syncSources() {
        const sources = sourcesFor(this._config.stats);
        // Cheap sources are always sampled so the dropdown has history.
        for (const src of ['cpu', 'mem', 'net', 'cpuTemp', 'disk'])
            sources.add(src);
        if (this._menuOpen) {
            for (const src of ['cpuFreq', 'gpu', 'system'])
                sources.add(src);
        }
        this._sampler.setSources(sources);
    }

    _createIndicator() {
        this._indicator?.destroy();
        const indicator = new ResourceIndicator(this);
        // The shell can destroy the panel (e.g. on shutdown) before disable().
        indicator.connect('destroy', () => {
            if (this._indicator === indicator)
                this._indicator = null;
        });
        this._indicator = indicator;
        this._indicator.rebuild(this._config);
        Main.panel.addToStatusArea(this.uuid, this._indicator,
            this._settings.get_int('panel-index'), this._settings.get_string('panel-position'));
        this._refreshUi();
    }

    _onSettingChanged(key) {
        this._loadConfig();
        switch (key) {
        case 'panel-position':
        case 'panel-index':
            this._createIndicator();
            return;
        case 'update-interval':
            this._restartTimer();
            break;
        case 'disk-path':
            this._model.clear(['disk_used_pct', 'disk_used', 'disk_free_pct', 'disk_free']);
            break;
        case 'network-interface':
            this._model.clear(['net_rx', 'net_tx']);
            break;
        }
        if (REBUILD_KEYS.has(key))
            this._indicator.rebuild(this._config);
        this._refreshUi();
    }

    _restartTimer() {
        if (this._timerId)
            GLib.source_remove(this._timerId);
        this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._intervalMs(), () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
        GLib.Source.set_name_by_id(this._timerId, '[resource-bar] sample');
    }

    async _tick() {
        const sampler = this._sampler;
        let fresh = false;
        try {
            fresh = await sampler.sample();
        } catch (e) {
            console.error(`[resource-bar] ${e}`);
        }
        // The extension may have been disabled while sampling.
        if (!fresh || sampler !== this._sampler)
            return;
        this._model.push(sampler.snapshot);
        this._refreshUi();
    }

    _refreshUi() {
        if (!this._indicator)
            return;
        const ctx = {
            snapshot: this._sampler.snapshot,
            model: this._model,
            opts: this._opts,
            thresholds: this._thresholds,
            highlight: this._highlight,
            hasGpu: this._sampler.hasGpu,
        };
        this._indicator.refresh(ctx);
        if (this._menuOpen)
            this._indicator.popup?.refresh(ctx);
    }

    onMenuOpenChanged(open) {
        this._menuOpen = open;
        this._syncSources();
        if (open) {
            this._refreshUi();
            this._tick();
        }
    }
}
