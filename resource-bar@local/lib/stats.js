// Stat catalogue, formatting and threshold logic. Pure JS: shared by the
// shell extension and the preferences window, so no Shell/St imports here.

// Points visible across a graph's width.
export const HISTORY_SIZE = 30;
// Samples kept: two more than visible, so while a graph scrolls (shifted up to
// two steps right) its left edge is still covered by older points.
export const HISTORY_KEEP = HISTORY_SIZE + 2;

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

// Threshold groups (same defaults as Noctalia's sysmon threshold profile).
// Below "activity" the value uses the normal panel color; between activity
// and critical it fades toward the highlight color; at critical it is fully
// highlighted.
export const THRESHOLDS = {
    cpu_usage: {name: 'Uso da CPU', unit: '%', min: 0, max: 100, step: 1, digits: 0, defaults: [50, 90]},
    cpu_temp: {name: 'Temperatura da CPU', unit: '°C', min: 0, max: 120, step: 1, digits: 0, defaults: [60, 85]},
    cpu_freq: {name: 'Frequência da CPU', unit: 'GHz', min: 0, max: 8, step: 0.1, digits: 1, defaults: [2.5, 4.5]},
    gpu_usage: {name: 'Uso da GPU', unit: '%', min: 0, max: 100, step: 1, digits: 0, defaults: [50, 95]},
    gpu_temp: {name: 'Temperatura da GPU', unit: '°C', min: 0, max: 120, step: 1, digits: 0, defaults: [60, 85]},
    gpu_vram: {name: 'VRAM', unit: '%', min: 0, max: 100, step: 1, digits: 0, defaults: [50, 90]},
    ram: {name: 'Memória', unit: '%', min: 0, max: 100, step: 1, digits: 0, defaults: [60, 90]},
    swap: {name: 'Swap', unit: '%', min: 0, max: 100, step: 1, digits: 0, defaults: [20, 80]},
    disk: {name: 'Disco (uso)', unit: '%', min: 0, max: 100, step: 1, digits: 0, defaults: [80, 95]},
    net_rx: {name: 'Download', unit: 'MB/s', min: 0, max: 1000, step: 0.1, digits: 1, defaults: [1, 50]},
    net_tx: {name: 'Upload', unit: 'MB/s', min: 0, max: 1000, step: 0.1, digits: 1, defaults: [1, 50]},
};

const pct = v => `${Math.round(v)}%`;
const celsius = v => `${Math.round(v)}°C`;
// Disk sizes: GiB, or TiB from 1 TiB up so big drives stay short in the panel.
const diskSize = bytes => bytes >= 1024 * GIB
    ? `${(bytes / (1024 * GIB)).toFixed(1)} TiB`
    : `${(bytes / GIB).toFixed(1)} GiB`;

export function formatBytes(bytes) {
    const mib = bytes / MIB;
    if (mib >= 1024)
        return `${(mib / 1024).toFixed(1)} GiB`;
    return `${Math.round(mib)} MiB`;
}

export function formatUsage(used, total) {
    if (total >= 1024 * GIB)
        return `${(used / (1024 * GIB)).toFixed(1)} / ${(total / (1024 * GIB)).toFixed(1)} TiB`;
    return `${(used / GIB).toFixed(1)} / ${(total / GIB).toFixed(1)} GiB`;
}

export function formatRate(bytesPerSec, {unit = 'auto', compact = false, decimals = 1} = {}) {
    const units = [
        [1e9, 'GB/s', 'G'],
        [1e6, 'MB/s', 'M'],
        [1e3, 'kB/s', 'k'],
    ];
    let pick;
    if (unit === 'kb')
        pick = units[2];
    else if (unit === 'mb')
        pick = units[1];
    else
        pick = units.find(([div]) => bytesPerSec >= div) ?? units[2];

    const value = bytesPerSec / pick[0];
    if (compact)
        return `${value.toFixed(Math.max(0, Math.min(2, decimals)))}${pick[2]}`;
    return `${value.toFixed(value >= 100 ? 0 : 1)} ${pick[1]}`;
}

export function formatDuration(seconds) {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0)
        return `${d}d ${h}h`;
    if (h > 0)
        return `${h}h ${m}min`;
    return `${m}min`;
}

const percentNorm = v => v / 100;

function tempNorm(v, history) {
    const lo = Math.min(30, ...history, v);
    const hi = Math.max(80, ...history, v);
    return hi > lo ? (v - lo) / (hi - lo) : 0.5;
}

function rateNorm(v, history) {
    const hi = Math.max(10e3, ...history, v);
    return v / hi;
}

const vramPct = s => s.gpu && s.gpu.vramTotal > 0 && s.gpu.vramUsed !== null
    ? 100 * s.gpu.vramUsed / s.gpu.vramTotal : null;

// Disk stats take an optional mount point ("disk_used_pct:/mnt/data");
// without one they use the default disk from the settings.
export const diskFor = (s, param) => s.disks?.[param || s.defaultDisk] ?? null;
const diskUsedPct = (s, p) => diskFor(s, p)?.pct ?? null;
const diskFreePct = (s, p) => {
    const d = diskFor(s, p);
    return d ? 100 - d.pct : null;
};

// Each stat (param is the optional part after ":" in the key, e.g. a mount):
//   raw(snapshot, param)              number|null  history value, drives gauge/graph
//   level(snapshot, raw, param)       number       compared against thresholds (default raw)
//   text(snapshot, opts, raw, param)  string       label shown in the panel
//   norm(raw, history, snapshot)      0..1         gauge / graph position
export const STATS = {
    cpu_usage: {
        name: 'Uso da CPU', icon: 'cpu', threshold: 'cpu_usage', source: 'cpu',
        raw: s => s.cpu.usage,
        text: (s, o, v) => pct(v),
        norm: percentNorm,
    },
    cpu_temp: {
        name: 'Temperatura da CPU', icon: 'temperature', threshold: 'cpu_temp', source: 'cpuTemp',
        raw: s => s.cpuTemp,
        text: (s, o, v) => celsius(v),
        norm: tempNorm,
    },
    cpu_freq: {
        name: 'Frequência da CPU', icon: 'bolt', threshold: 'cpu_freq', source: 'cpuFreq',
        raw: s => s.cpuFreq ? s.cpuFreq.mhz : null,
        level: (s, v) => v / 1000,
        text: (s, o, v) => `${(v / 1000).toFixed(1)} GHz`,
        norm: (v, h, s) => v / (s.cpuFreq?.maxMhz || 5000),
    },
    gpu_usage: {
        name: 'Uso da GPU', icon: 'gpu', threshold: 'gpu_usage', source: 'gpu',
        raw: s => s.gpu ? s.gpu.usage : null,
        text: (s, o, v) => pct(v),
        norm: percentNorm,
    },
    gpu_temp: {
        name: 'Temperatura da GPU', icon: 'gpu-temperature', threshold: 'gpu_temp', source: 'gpu',
        raw: s => s.gpu ? s.gpu.temp : null,
        text: (s, o, v) => celsius(v),
        norm: tempNorm,
    },
    gpu_vram: {
        name: 'VRAM (%)', icon: 'gpu-memory', threshold: 'gpu_vram', source: 'gpu',
        raw: vramPct,
        text: (s, o, v) => pct(v),
        norm: percentNorm,
    },
    gpu_vram_used: {
        name: 'VRAM usada', icon: 'gpu-memory', threshold: 'gpu_vram', source: 'gpu',
        raw: vramPct,
        text: s => formatBytes(s.gpu.vramUsed),
        norm: percentNorm,
    },
    ram_pct: {
        name: 'Memória (%)', icon: 'memory', threshold: 'ram', source: 'mem',
        raw: s => s.mem ? s.mem.pct : null,
        text: (s, o, v) => pct(v),
        norm: percentNorm,
    },
    ram_used: {
        name: 'Memória usada', icon: 'memory', threshold: 'ram', source: 'mem',
        raw: s => s.mem ? s.mem.pct : null,
        text: s => formatBytes(s.mem.used),
        norm: percentNorm,
    },
    swap_pct: {
        name: 'Swap (%)', icon: 'swap', threshold: 'swap', source: 'mem',
        raw: s => s.mem && s.mem.swapTotal > 0 ? s.mem.swapPct : null,
        text: (s, o, v) => pct(v),
        norm: percentNorm,
    },
    disk_used_pct: {
        name: 'Disco usado (%)', icon: 'disk', threshold: 'disk', source: 'disk',
        raw: diskUsedPct,
        text: (s, o, v) => pct(v),
        norm: percentNorm,
    },
    disk_used: {
        name: 'Disco usado', icon: 'disk', threshold: 'disk', source: 'disk',
        raw: diskUsedPct,
        text: (s, o, v, p) => diskSize(diskFor(s, p).used),
        norm: percentNorm,
    },
    disk_free_pct: {
        name: 'Disco livre (%)', icon: 'disk', threshold: 'disk', source: 'disk',
        raw: diskFreePct,
        level: (s, v, p) => diskFor(s, p).pct,
        text: (s, o, v) => pct(v),
        norm: percentNorm,
    },
    disk_free: {
        name: 'Disco livre', icon: 'disk', threshold: 'disk', source: 'disk',
        raw: diskFreePct,
        level: (s, v, p) => diskFor(s, p).pct,
        text: (s, o, v, p) => diskSize(diskFor(s, p).avail),
        norm: percentNorm,
    },
    net_rx: {
        name: 'Download', icon: 'download', threshold: 'net_rx', source: 'net',
        raw: s => s.net ? s.net.rx : null,
        level: (s, v) => v / 1e6,
        text: (s, o, v) => formatRate(v, o.net),
        norm: rateNorm,
    },
    net_tx: {
        name: 'Upload', icon: 'upload', threshold: 'net_tx', source: 'net',
        raw: s => s.net ? s.net.tx : null,
        level: (s, v) => v / 1e6,
        text: (s, o, v) => formatRate(v, o.net),
        norm: rateNorm,
    },
};

export const STAT_IDS = Object.keys(STATS);

export const DISK_IDS = STAT_IDS.filter(id => STATS[id].source === 'disk');

// Panel entries are "id" or "id:param" (only disk stats use a param: the
// mount point). Splits at the first ":" so mount paths may contain colons.
export function parseKey(key) {
    const i = key.indexOf(':');
    return i < 0 ? {id: key, param: ''} : {id: key.slice(0, i), param: key.slice(i + 1)};
}

// Resource a stat belongs to, for per-resource graph colors.
const CATEGORY_BY_SOURCE = {
    cpu: 'cpu', cpuTemp: 'cpu', cpuFreq: 'cpu',
    mem: 'memory', gpu: 'gpu', disk: 'disk', net: 'network',
};

export function categoryOf(key) {
    return CATEGORY_BY_SOURCE[STATS[parseKey(key).id]?.source] ?? null;
}

export function makeKey(id, param = '') {
    return param ? `${id}:${param}` : id;
}

export function isValidKey(key) {
    const {id, param} = parseKey(key);
    return Boolean(STATS[id]) && (!param || STATS[id].source === 'disk');
}

// Data sources the sampler must read for a set of stat keys.
export function sourcesFor(keys) {
    const out = new Set();
    for (const key of keys) {
        const def = STATS[parseKey(key).id];
        if (def)
            out.add(def.source);
    }
    return out;
}

export function gradientFactor(value, activity, critical) {
    // Same curve as Noctalia: jump to 25% tint when crossing the activity
    // threshold so "busy" is visible immediately, then ramp to 100%.
    const ONSET = 0.25;
    const v = Math.max(value, 0);
    const c = Math.max(critical, 0);
    if (c <= 0 || v <= 0)
        return 0;
    const a = Math.min(Math.max(activity, 0), c);
    if (v <= a)
        return 0;
    if (v >= c)
        return 1;
    return ONSET + (1 - ONSET) * (v - a) / (c - a);
}

// Removes the unit suffix ("45°C" -> "45", "1.2 MB/s" -> "1.2").
export function stripUnits(text) {
    const m = text.match(/^(.*\d)/);
    return m ? m[1].trim() : text;
}

const isNum = v => typeof v === 'number' && Number.isFinite(v);

export class StatModel {
    constructor() {
        this._history = new Map();
        this._counts = new Map();
    }

    // Records every parameterless stat plus the given keys (panel items that
    // name a disk), so graphs have history for whatever is on screen.
    push(snapshot, keys = []) {
        const all = new Set([...STAT_IDS, ...keys]);
        for (const key of all) {
            const {id, param} = parseKey(key);
            const def = STATS[id];
            if (!def)
                continue;
            let raw = null;
            try {
                raw = def.raw(snapshot, param);
            } catch {
                raw = null;
            }
            if (!isNum(raw))
                continue;
            let h = this._history.get(key);
            if (!h) {
                h = [];
                this._history.set(key, h);
            }
            h.push(raw);
            if (h.length > HISTORY_KEEP)
                h.shift();
            this._counts.set(key, (this._counts.get(key) ?? 0) + 1);
        }
    }

    clear(keys) {
        for (const key of keys) {
            this._history.delete(key);
            this._counts.delete(key);
        }
    }

    // Samples pushed so far for a key; graphs use it to spot a new sample.
    count(key) {
        return this._counts.get(key) ?? 0;
    }

    history(key) {
        return this._history.get(key) ?? [];
    }

    normalizedHistory(key, snapshot) {
        const def = STATS[parseKey(key).id];
        const h = this.history(key);
        return h.map(v => clamp01(def.norm(v, h, snapshot)));
    }

    // Returns {available, text, norm, factor}.
    evaluate(key, snapshot, opts, thresholds) {
        const {id, param} = parseKey(key);
        const def = STATS[id];
        let raw = null;
        try {
            raw = def.raw(snapshot, param);
        } catch {
            raw = null;
        }
        if (!isNum(raw))
            return {available: false, text: '--', norm: 0, factor: 0};

        const level = def.level ? def.level(snapshot, raw, param) : raw;
        const [activity, critical] = thresholds[def.threshold] ?? THRESHOLDS[def.threshold].defaults;
        let text = def.text(snapshot, opts, raw, param);
        if (opts.showUnits === false)
            text = stripUnits(text);
        return {
            available: true,
            text,
            norm: clamp01(def.norm(raw, this.history(key), snapshot)),
            factor: gradientFactor(level, activity, critical),
        };
    }
}

function clamp01(v) {
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}
