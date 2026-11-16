// Stat catalogue, formatting and threshold logic. Pure JS: shared by the
// shell extension and the preferences window, so no Shell/St imports here.

// Marks a string for translation without translating it: this module is
// shared by the shell and the preferences, which each translate with _().
export const N_ = s => s;

// Replaces %s / %d placeholders in order (String.prototype.format is not
// available in the preferences process).
export function fmt(str, ...args) {
    let i = 0;
    return str.replace(/%[sd]/g, () => String(args[i++]));
}

// Points visible across a graph's width by default: 30 s at the default 1 s
// interval. The "graph-span" setting changes it (span / interval).
export const HISTORY_SIZE = 30;
// Samples kept beyond the visible ones, so while a graph scrolls (shifted up to
// two steps right) its left edge is still covered by older points.
export const HISTORY_EXTRA = 2;

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

// Threshold groups (same defaults as Noctalia's sysmon threshold profile).
// Below "activity" the value uses the normal panel color; between activity
// and critical it fades toward the highlight color; at critical it is fully
// highlighted.
export const THRESHOLDS = {
    cpu_usage: {name: N_('CPU usage'), unit: '%', min: 0, max: 100, step: 1, digits: 0, defaults: [50, 90]},
    cpu_temp: {name: N_('CPU temperature'), unit: '°C', min: 0, max: 120, step: 1, digits: 0, defaults: [60, 85]},
    cpu_freq: {name: N_('CPU frequency'), unit: 'GHz', min: 0, max: 8, step: 0.1, digits: 1, defaults: [2.5, 4.5]},
    gpu_usage: {name: N_('GPU usage'), unit: '%', min: 0, max: 100, step: 1, digits: 0, defaults: [50, 95]},
    gpu_temp: {name: N_('GPU temperature'), unit: '°C', min: 0, max: 120, step: 1, digits: 0, defaults: [60, 85]},
    gpu_vram: {name: N_('VRAM'), unit: '%', min: 0, max: 100, step: 1, digits: 0, defaults: [50, 90]},
    ram: {name: N_('Memory'), unit: '%', min: 0, max: 100, step: 1, digits: 0, defaults: [60, 90]},
    swap: {name: N_('Swap'), unit: '%', min: 0, max: 100, step: 1, digits: 0, defaults: [20, 80]},
    disk: {name: N_('Disk (space used)'), unit: '%', min: 0, max: 100, step: 1, digits: 0, defaults: [80, 95]},
    disk_io: {name: N_('Disk (activity)'), unit: '%', min: 0, max: 100, step: 1, digits: 0, defaults: [50, 90]},
    net_rx: {name: N_('Download'), unit: 'MB/s', min: 0, max: 1000, step: 0.1, digits: 1, defaults: [1, 50]},
    net_tx: {name: N_('Upload'), unit: 'MB/s', min: 0, max: 1000, step: 0.1, digits: 1, defaults: [1, 50]},
};

const pct = v => `${Math.round(v)}%`;
const celsius = v => `${Math.round(v)}°C`;
const ghz = mhz => `${(mhz / 1000).toFixed(1)} GHz`;
// Three significant digits ("0.40", "4.05", "40.5", "405"): every reading
// has three digits, so speeds and sizes keep their width as they change.
function sig3(v) {
    if (v === 0)
        return '0';
    if (v < 9.995)
        return v.toFixed(2);
    if (v < 99.95)
        return v.toFixed(1);
    return v.toFixed(0);
}

// value in units[i] = [size, label]: the largest unit it reaches, or the next
// one up when the number would round to 1000 ("999 MiB", then "0.98 GiB").
function scaled(value, units, num = sig3) {
    let i = 0;
    while (i < units.length - 1 &&
           (value >= units[i + 1][0] || Number(num(value / units[i][0])) >= 1000))
        i++;
    return [num(value / units[i][0]), units[i]];
}

const BYTE_UNITS = [[MIB, 'MiB'], [GIB, 'GiB'], [1024 * GIB, 'TiB']];
const DISK_UNITS = [[GIB, 'GiB'], [1024 * GIB, 'TiB']];

// Disk sizes start at GiB so big drives stay short in the panel.
function diskSize(bytes) {
    const [n, [, label]] = scaled(bytes, DISK_UNITS);
    return `${n} ${label}`;
}

export function formatBytes(bytes) {
    const [n, [, label]] = scaled(bytes, BYTE_UNITS);
    return `${n} ${label}`;
}

export function formatUsage(used, total) {
    if (total >= 1024 * GIB)
        return `${(used / (1024 * GIB)).toFixed(1)} / ${(total / (1024 * GIB)).toFixed(1)} TiB`;
    return `${(used / GIB).toFixed(1)} / ${(total / GIB).toFixed(1)} GiB`;
}

const RATE_UNITS = [[1e3, 'kB/s', 'k'], [1e6, 'MB/s', 'M'], [1e9, 'GB/s', 'G']];

// Speeds: three significant digits, or a fixed number of decimals in the
// compact form ("405k"); "kb" and "mb" pin the unit.
export function formatRate(bytesPerSec, {unit = 'auto', compact = false, decimals = 1} = {}) {
    const d = Math.max(0, Math.min(2, decimals));
    const num = compact ? v => v.toFixed(d) : sig3;
    let n, u;
    if (unit === 'kb' || unit === 'mb') {
        u = RATE_UNITS[unit === 'kb' ? 0 : 1];
        n = num(bytesPerSec / u[0]);
    } else {
        [n, u] = scaled(bytesPerSec, RATE_UNITS, num);
    }
    return compact ? `${n}${u[2]}` : `${n} ${u[1]}`;
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

// Widest texts a stat can show (see StatModel.widestTexts). Digits are
// tabular, so only their count, the decimal point and the unit matter.
const widePct = () => [pct(100)];
const wideTemp = () => [celsius(100)];
// Values just under 10, 100 and 1000 of every unit hit the rounding edges
// ("10.0", "100", "1.00 GiB", "1000.00M" with two decimals), up to max.
function edgeTexts(format, unitSizes, max) {
    const out = [format(max)];
    for (const size of unitSizes) {
        for (const m of [9.999999, 99.99999, 999.9999]) {
            if (m * size <= max)
                out.push(format(m * size));
        }
    }
    return out;
}
const wideBytes = total => edgeTexts(formatBytes, BYTE_UNITS.map(u => u[0]), total || 1024 * GIB);
const wideDisk = total => (total > 0 ? edgeTexts(diskSize, DISK_UNITS.map(u => u[0]), total) : []);
// Speeds stop at a 10 Gbit/s link, or 1 Gbit/s when shown in kB/s.
const wideRates = (net = {}) =>
    edgeTexts(v => formatRate(v, net), RATE_UNITS.map(u => u[0]), net.unit === 'kb' ? 1.25e8 : 1.25e9);

// Disk stats take an optional mount point ("disk_used_pct:/mnt/data");
// without one they use the default disk from the settings.
export const diskFor = (s, param) => s.disks?.[param || s.defaultDisk] ?? null;
const diskUsedPct = (s, p) => diskFor(s, p)?.pct ?? null;
// Share of time the disk behind a mount spent reading/writing (iostat %util).
const diskUtil = (s, p) => {
    const path = p || s.defaultDisk;
    const mount = s.diskList?.find(m => m.path === path);
    return mount ? s.diskIo?.[mount.ioName]?.util ?? null : null;
};
const diskFreePct = (s, p) => {
    const d = diskFor(s, p);
    return d ? 100 - d.pct : null;
};

// Each stat (param is the optional part after ":" in the key, e.g. a mount):
//   raw(snapshot, param)              number|null  history value, drives gauge/graph
//   level(snapshot, raw, param)       number       compared against thresholds (default raw)
//   text(snapshot, opts, raw, param)  string       label shown in the panel
//   norm(raw, history, snapshot)      0..1         gauge / graph position
//   widest(snapshot, opts, param)     string[]     texts as wide as any text() can be
export const STATS = {
    cpu_usage: {
        name: N_('CPU usage'), icon: 'cpu', threshold: 'cpu_usage', source: 'cpu',
        raw: s => s.cpu.usage,
        text: (s, o, v) => pct(v),
        widest: widePct,
        norm: percentNorm,
    },
    cpu_temp: {
        name: N_('CPU temperature'), icon: 'temperature', threshold: 'cpu_temp', source: 'cpuTemp',
        raw: s => s.cpuTemp,
        text: (s, o, v) => celsius(v),
        widest: wideTemp,
        norm: tempNorm,
    },
    cpu_freq: {
        name: N_('CPU frequency'), icon: 'bolt', threshold: 'cpu_freq', source: 'cpuFreq',
        raw: s => s.cpuFreq ? s.cpuFreq.mhz : null,
        level: (s, v) => v / 1000,
        text: (s, o, v) => ghz(v),
        widest: () => [ghz(9900)],
        norm: (v, h, s) => v / (s.cpuFreq?.maxMhz || 5000),
    },
    gpu_usage: {
        name: N_('GPU usage'), icon: 'gpu', threshold: 'gpu_usage', source: 'gpu',
        raw: s => s.gpu ? s.gpu.usage : null,
        text: (s, o, v) => pct(v),
        widest: widePct,
        norm: percentNorm,
    },
    gpu_temp: {
        name: N_('GPU temperature'), icon: 'gpu-temperature', threshold: 'gpu_temp', source: 'gpu',
        raw: s => s.gpu ? s.gpu.temp : null,
        text: (s, o, v) => celsius(v),
        widest: wideTemp,
        norm: tempNorm,
    },
    gpu_vram: {
        name: N_('VRAM (%)'), icon: 'gpu-memory', threshold: 'gpu_vram', source: 'gpu',
        raw: vramPct,
        text: (s, o, v) => pct(v),
        widest: widePct,
        norm: percentNorm,
    },
    gpu_vram_used: {
        name: N_('VRAM used'), icon: 'gpu-memory', threshold: 'gpu_vram', source: 'gpu',
        raw: vramPct,
        text: s => formatBytes(s.gpu.vramUsed),
        widest: s => wideBytes(s.gpu?.vramTotal),
        norm: percentNorm,
    },
    ram_pct: {
        name: N_('Memory (%)'), icon: 'memory', threshold: 'ram', source: 'mem',
        raw: s => s.mem ? s.mem.pct : null,
        text: (s, o, v) => pct(v),
        widest: widePct,
        norm: percentNorm,
    },
    ram_used: {
        name: N_('Memory used'), icon: 'memory', threshold: 'ram', source: 'mem',
        raw: s => s.mem ? s.mem.pct : null,
        text: s => formatBytes(s.mem.used),
        widest: s => wideBytes(s.mem?.total),
        norm: percentNorm,
    },
    swap_pct: {
        name: N_('Swap (%)'), icon: 'swap', threshold: 'swap', source: 'mem',
        raw: s => s.mem && s.mem.swapTotal > 0 ? s.mem.swapPct : null,
        text: (s, o, v) => pct(v),
        widest: widePct,
        norm: percentNorm,
    },
    disk_used_pct: {
        name: N_('Disk used (%)'), icon: 'disk', threshold: 'disk', source: 'disk',
        raw: diskUsedPct,
        text: (s, o, v) => pct(v),
        widest: widePct,
        norm: percentNorm,
    },
    disk_used: {
        name: N_('Disk used'), icon: 'disk', threshold: 'disk', source: 'disk',
        raw: diskUsedPct,
        text: (s, o, v, p) => diskSize(diskFor(s, p).used),
        widest: (s, o, p) => wideDisk(diskFor(s, p)?.total),
        norm: percentNorm,
    },
    disk_free_pct: {
        name: N_('Disk free (%)'), icon: 'disk', threshold: 'disk', source: 'disk',
        raw: diskFreePct,
        level: (s, v, p) => diskFor(s, p).pct,
        text: (s, o, v) => pct(v),
        widest: widePct,
        norm: percentNorm,
    },
    disk_free: {
        name: N_('Disk free'), icon: 'disk', threshold: 'disk', source: 'disk',
        raw: diskFreePct,
        level: (s, v, p) => diskFor(s, p).pct,
        text: (s, o, v, p) => diskSize(diskFor(s, p).avail),
        widest: (s, o, p) => wideDisk(diskFor(s, p)?.total),
        norm: percentNorm,
    },
    disk_util: {
        name: N_('Disk activity'), icon: 'disk', threshold: 'disk_io', source: 'diskio',
        raw: diskUtil,
        text: (s, o, v) => pct(v),
        widest: widePct,
        norm: percentNorm,
    },
    net_rx: {
        name: N_('Download'), icon: 'download', threshold: 'net_rx', source: 'net',
        raw: s => s.net ? s.net.rx : null,
        level: (s, v) => v / 1e6,
        text: (s, o, v) => formatRate(v, o.net),
        widest: (s, o) => wideRates(o.net),
        norm: rateNorm,
    },
    net_tx: {
        name: N_('Upload'), icon: 'upload', threshold: 'net_tx', source: 'net',
        raw: s => s.net ? s.net.tx : null,
        level: (s, v) => v / 1e6,
        text: (s, o, v) => formatRate(v, o.net),
        widest: (s, o) => wideRates(o.net),
        norm: rateNorm,
    },
};

export const STAT_IDS = Object.keys(STATS);

// Stats that can name a disk ("id:/mount"): space and activity.
export const DISK_IDS = STAT_IDS.filter(id => ['disk', 'diskio'].includes(STATS[id].source));

// History key of a disk's activity, used by the Discos card graphs.
export const diskUtilKey = path => `disk_util:${path}`;

// Panel entries are "id" or "id:param" (only disk stats use a param: the
// mount point). Splits at the first ":" so mount paths may contain colons.
export function parseKey(key) {
    const i = key.indexOf(':');
    return i < 0 ? {id: key, param: ''} : {id: key.slice(0, i), param: key.slice(i + 1)};
}

// Resource a stat belongs to, for per-resource graph colors.
const CATEGORY_BY_SOURCE = {
    cpu: 'cpu', cpuTemp: 'cpu', cpuFreq: 'cpu',
    mem: 'memory', gpu: 'gpu', disk: 'disk', diskio: 'disk', net: 'network',
};

export function categoryOf(key) {
    return CATEGORY_BY_SOURCE[STATS[parseKey(key).id]?.source] ?? null;
}

export function makeKey(id, param = '') {
    return param ? `${id}:${param}` : id;
}

export function isValidKey(key) {
    const {id, param} = parseKey(key);
    return Boolean(STATS[id]) && (!param || DISK_IDS.includes(id));
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
    constructor(size = HISTORY_SIZE) {
        this._history = new Map();
        this._counts = new Map();
        this.size = size;
    }

    // Points visible across a graph; older samples beyond the extra ones go.
    setSize(size) {
        size = Math.max(2, Math.round(size));
        if (size === this.size)
            return;
        this.size = size;
        const keep = size + HISTORY_EXTRA;
        for (const h of this._history.values()) {
            if (h.length > keep)
                h.splice(0, h.length - keep);
        }
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
            if (h.length > this.size + HISTORY_EXTRA)
                h.shift();
            this._counts.set(key, (this._counts.get(key) ?? 0) + 1);
        }
    }

    clearAll() {
        this._history.clear();
        this._counts.clear();
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

    // Texts at least as wide as anything the stat can show with these
    // options, digits as "0" (they are tabular): the top bar reserves the
    // widest, so an item keeps its width whatever its value.
    widestTexts(key, snapshot, opts) {
        const {id, param} = parseKey(key);
        let texts;
        try {
            texts = STATS[id]?.widest?.(snapshot, opts, param) ?? [];
        } catch {
            texts = [];
        }
        return texts.map(t => (opts.showUnits === false ? stripUnits(t) : t).replace(/\d/g, '0'));
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
