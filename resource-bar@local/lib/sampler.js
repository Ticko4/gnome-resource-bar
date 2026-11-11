// System sampler: reads /proc and /sys asynchronously so the shell never
// blocks. Only depends on GLib/Gio, so it can also run under plain `gjs`.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'query_filesystem_info_async');
Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async');

const decoder = new TextDecoder();

async function readText(path, cancellable) {
    const [bytes] = await Gio.File.new_for_path(path).load_contents_async(cancellable);
    return decoder.decode(bytes);
}

async function readNumber(path, cancellable) {
    const n = Number((await readText(path, cancellable)).trim());
    return Number.isFinite(n) ? n : null;
}

// Synchronous reads are only used once, during discovery, on static sysfs
// attributes (name/label/vendor) that never touch hardware.
function readSync(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? decoder.decode(bytes).trim() : null;
    } catch {
        return null;
    }
}

function listDir(path) {
    const out = [];
    let dir = null;
    try {
        dir = GLib.Dir.open(path, 0);
        let name;
        while ((name = dir.read_name()) !== null)
            out.push(name);
    } catch {
        // missing directory
    } finally {
        dir?.close();
    }
    return out.sort();
}

const exists = path => GLib.file_test(path, GLib.FileTest.EXISTS);

function isCancelled(e) {
    return e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

function findCpuTempSensor() {
    const base = '/sys/class/hwmon';
    const preferred = [
        ['k10temp', ['Tdie', 'Tctl']],
        ['zenpower', ['Tdie', 'Tctl']],
        ['coretemp', ['Package id 0']],
        ['cpu_thermal', []],
        ['soc_thermal', []],
        ['acpitz', []],
    ];
    const hwmons = listDir(base).map(h => ({dir: `${base}/${h}`, name: readSync(`${base}/${h}/name`)}));

    for (const [driver, labels] of preferred) {
        const hw = hwmons.find(h => h.name === driver);
        if (!hw)
            continue;
        const inputs = listDir(hw.dir).filter(f => /^temp\d+_input$/.test(f));
        for (const label of labels) {
            const match = inputs.find(f => readSync(`${hw.dir}/${f.replace('_input', '_label')}`) === label);
            if (match)
                return `${hw.dir}/${match}`;
        }
        if (inputs.length > 0)
            return `${hw.dir}/${inputs[0]}`;
    }

    // Fallback: thermal zones.
    const zones = listDir('/sys/class/thermal').filter(z => z.startsWith('thermal_zone'));
    for (const type of ['x86_pkg_temp', 'cpu-thermal', 'acpitz']) {
        const z = zones.find(zz => readSync(`/sys/class/thermal/${zz}/type`) === type);
        if (z)
            return `/sys/class/thermal/${z}/temp`;
    }
    return null;
}

function findGpu() {
    const cards = listDir('/sys/class/drm').filter(c => /^card\d+$/.test(c));
    const gpus = [];
    for (const card of cards) {
        const dev = `/sys/class/drm/${card}/device`;
        const vendor = readSync(`${dev}/vendor`);
        if (vendor === '0x1002') {
            const hwmon = listDir(`${dev}/hwmon`)[0];
            gpus.push({
                kind: 'amd',
                dev,
                busy: `${dev}/gpu_busy_percent`,
                vramUsed: `${dev}/mem_info_vram_used`,
                vramTotal: `${dev}/mem_info_vram_total`,
                temp: hwmon ? `${dev}/hwmon/${hwmon}/temp1_input` : null,
                vram: Number(readSync(`${dev}/mem_info_vram_total`) ?? 0),
            });
        } else if (vendor === '0x10de') {
            const smi = GLib.find_program_in_path('nvidia-smi');
            if (smi)
                gpus.push({kind: 'nvidia', dev, smi, vram: Number.MAX_SAFE_INTEGER});
        }
    }
    // Prefer the discrete card (largest VRAM; NVIDIA counts as discrete).
    gpus.sort((a, b) => b.vram - a.vram);
    return gpus[0] ?? null;
}

// Keeps one long-running `nvidia-smi -lms` process instead of spawning a new
// one every tick, which would be far more expensive.
class NvidiaMonitor {
    constructor(smiPath) {
        this._smi = smiPath;
        this._proc = null;
        this._interval = 0;
        this.latest = null;
    }

    ensure(intervalMs) {
        if (this._proc && this._interval === intervalMs)
            return;
        this.stop();
        this._interval = intervalMs;
        try {
            this._proc = Gio.Subprocess.new([
                this._smi,
                '--query-gpu=name,utilization.gpu,temperature.gpu,memory.used,memory.total',
                '--format=csv,noheader,nounits',
                `--loop-ms=${intervalMs}`,
            ], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            console.warn(`[resource-bar] nvidia-smi falhou: ${e.message}`);
            this._proc = null;
            return;
        }
        const proc = this._proc;
        const stream = new Gio.DataInputStream({base_stream: proc.get_stdout_pipe(), close_base_stream: true});
        this._cancellable = new Gio.Cancellable();
        this._readLoop(proc, stream, this._cancellable).catch(() => {});
    }

    async _readLoop(proc, stream, cancellable) {
        while (this._proc === proc) {
            // eslint-disable-next-line no-await-in-loop
            const [line] = await stream.read_line_async(GLib.PRIORITY_LOW, cancellable);
            if (line === null)
                break;
            const parts = decoder.decode(line).split(',').map(p => p.trim());
            if (parts.length < 5)
                continue;
            const num = v => {
                const n = Number(v);
                return Number.isFinite(n) ? n : null;
            };
            const used = num(parts[3]);
            const total = num(parts[4]);
            this.latest = {
                name: parts[0],
                usage: num(parts[1]),
                temp: num(parts[2]),
                vramUsed: used === null ? null : used * 1024 * 1024,
                vramTotal: total === null ? null : total * 1024 * 1024,
                at: GLib.get_monotonic_time(),
            };
        }
        if (this._proc === proc) {
            this._proc = null;
            this.latest = null;
        }
    }

    stop() {
        this._cancellable?.cancel();
        this._cancellable = null;
        if (this._proc) {
            this._proc.force_exit();
            this._proc = null;
        }
        this.latest = null;
    }
}

export function emptySnapshot() {
    return {
        cpu: {usage: null, cores: []},
        cpuTemp: null,
        cpuFreq: null,
        mem: null,
        disk: null,
        net: null,
        gpu: null,
        system: null,
    };
}

export class Sampler {
    constructor() {
        this.snapshot = emptySnapshot();
        this._cancellable = new Gio.Cancellable();
        this._busy = false;
        this._prevCpu = null;
        this._prevNet = null;
        this._physical = new Map();
        this._diskPath = '/';
        this._iface = '';
        this._diskStamp = 0;
        this._sources = new Set(['cpu', 'mem', 'net']);
        this._interval = 1000;

        this._cpuTempPath = findCpuTempSensor();
        const maxKhz = Number(readSync('/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq'));
        this._cpuMaxMhz = Number.isFinite(maxKhz) && maxKhz > 0 ? maxKhz / 1000 : null;
        this._gpu = findGpu();
        this._nvidia = this._gpu?.kind === 'nvidia' ? new NvidiaMonitor(this._gpu.smi) : null;
    }

    get hasGpu() {
        return this._gpu !== null;
    }

    get gpuKind() {
        return this._gpu?.kind ?? null;
    }

    setOptions({diskPath, networkInterface, interval}) {
        if (diskPath !== undefined && diskPath !== this._diskPath) {
            this._diskPath = diskPath || '/';
            this._diskStamp = 0;
            this.snapshot.disk = null;
        }
        if (networkInterface !== undefined && networkInterface !== this._iface) {
            this._iface = networkInterface;
            this._prevNet = null;
            this.snapshot.net = null;
        }
        if (interval !== undefined)
            this._interval = interval;
    }

    setSources(sources) {
        this._sources = new Set(sources);
        if (!this._sources.has('gpu'))
            this._nvidia?.stop();
    }

    // Returns false when a previous sample is still running.
    async sample() {
        if (this._busy)
            return false;
        this._busy = true;
        const c = this._cancellable;
        const want = this._sources;
        const jobs = [this._sampleCpu(c), this._sampleMem(c), this._sampleNet(c)];
        if (want.has('cpuTemp'))
            jobs.push(this._sampleCpuTemp(c));
        if (want.has('cpuFreq'))
            jobs.push(this._sampleCpuFreq(c));
        if (want.has('disk'))
            jobs.push(this._sampleDisk(c));
        if (want.has('gpu'))
            jobs.push(this._sampleGpu(c));
        else
            this.snapshot.gpu = null;
        if (want.has('system'))
            jobs.push(this._sampleSystem(c));

        try {
            const results = await Promise.allSettled(jobs);
            for (const r of results) {
                if (r.status === 'rejected' && !isCancelled(r.reason))
                    console.debug(`[resource-bar] ${r.reason}`);
            }
        } finally {
            this._busy = false;
        }
        return !c.is_cancelled();
    }

    async _sampleCpu(c) {
        const text = await readText('/proc/stat', c);
        const now = {};
        for (const line of text.split('\n')) {
            if (!line.startsWith('cpu'))
                break;
            const parts = line.trim().split(/\s+/);
            const vals = parts.slice(1, 9).map(Number);
            const idle = vals[3] + (vals[4] || 0);
            const total = vals.reduce((a, b) => a + b, 0);
            now[parts[0]] = {idle, total};
        }
        const prev = this._prevCpu;
        this._prevCpu = now;
        if (!prev) {
            this.snapshot.cpu = {usage: null, cores: []};
            return;
        }
        const usage = key => {
            const a = prev[key];
            const b = now[key];
            if (!a || !b)
                return 0;
            const dt = b.total - a.total;
            return dt > 0 ? Math.min(100, Math.max(0, 100 * (1 - (b.idle - a.idle) / dt))) : 0;
        };
        const cores = Object.keys(now)
            .filter(k => k !== 'cpu')
            .sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)))
            .map(usage);
        this.snapshot.cpu = {usage: usage('cpu'), cores};
    }

    async _sampleCpuTemp(c) {
        if (!this._cpuTempPath) {
            this.snapshot.cpuTemp = null;
            return;
        }
        const milli = await readNumber(this._cpuTempPath, c);
        this.snapshot.cpuTemp = milli === null ? null : milli / 1000;
    }

    async _sampleCpuFreq(c) {
        const text = await readText('/proc/cpuinfo', c);
        const mhz = [...text.matchAll(/^cpu MHz\s*:\s*([\d.]+)/gm)].map(m => Number(m[1]));
        if (mhz.length === 0) {
            this.snapshot.cpuFreq = null;
            return;
        }
        const avg = mhz.reduce((a, b) => a + b, 0) / mhz.length;
        this.snapshot.cpuFreq = {mhz: avg, maxMhz: this._cpuMaxMhz ?? Math.max(...mhz)};
    }

    async _sampleMem(c) {
        const text = await readText('/proc/meminfo', c);
        const kv = {};
        for (const m of text.matchAll(/^(\w+):\s+(\d+)/gm))
            kv[m[1]] = Number(m[2]) * 1024;
        const total = kv.MemTotal ?? 0;
        const avail = kv.MemAvailable ?? (kv.MemFree ?? 0) + (kv.Cached ?? 0) + (kv.Buffers ?? 0);
        const used = Math.max(0, total - avail);
        const swapTotal = kv.SwapTotal ?? 0;
        const swapUsed = Math.max(0, swapTotal - (kv.SwapFree ?? 0));
        this.snapshot.mem = {
            total,
            used,
            avail,
            pct: total > 0 ? 100 * used / total : 0,
            swapTotal,
            swapUsed,
            swapPct: swapTotal > 0 ? 100 * swapUsed / swapTotal : 0,
        };
    }

    _isPhysical(iface) {
        let v = this._physical.get(iface);
        if (v === undefined) {
            v = exists(`/sys/class/net/${iface}/device`);
            this._physical.set(iface, v);
        }
        return v;
    }

    async _sampleNet(c) {
        const text = await readText('/proc/net/dev', c);
        const t = GLib.get_monotonic_time();
        const counters = {};
        for (const line of text.split('\n').slice(2)) {
            const idx = line.indexOf(':');
            if (idx < 0)
                continue;
            const name = line.slice(0, idx).trim();
            const f = line.slice(idx + 1).trim().split(/\s+/).map(Number);
            counters[name] = {rx: f[0], tx: f[8]};
        }

        const prev = this._prevNet;
        this._prevNet = {t, counters};
        if (!prev)
            return;
        const dt = (t - prev.t) / 1e6;
        if (dt <= 0)
            return;

        const interfaces = {};
        let rx = 0;
        let tx = 0;
        for (const [name, cur] of Object.entries(counters)) {
            const old = prev.counters[name];
            if (!old)
                continue;
            const r = Math.max(0, (cur.rx - old.rx) / dt);
            const w = Math.max(0, (cur.tx - old.tx) / dt);
            interfaces[name] = {rx: r, tx: w};
            const counted = this._iface ? name === this._iface : name !== 'lo' && this._isPhysical(name);
            if (counted) {
                rx += r;
                tx += w;
            }
        }
        this.snapshot.net = {rx, tx, interfaces};
    }

    async _sampleDisk(c) {
        // Filesystem usage changes slowly: refresh every 5 seconds.
        const now = GLib.get_monotonic_time();
        if (this.snapshot.disk && now - this._diskStamp < 5e6)
            return;
        this._diskStamp = now;
        const path = this._diskPath;
        const info = await Gio.File.new_for_path(path).query_filesystem_info_async(
            'filesystem::size,filesystem::free,filesystem::used', GLib.PRIORITY_LOW, c);
        const size = info.get_attribute_uint64('filesystem::size');
        const avail = info.get_attribute_uint64('filesystem::free');
        const used = info.get_attribute_uint64('filesystem::used');
        const denom = used + avail;
        if (path !== this._diskPath)
            return;
        this.snapshot.disk = {
            path,
            total: size,
            used,
            avail,
            pct: denom > 0 ? 100 * used / denom : 0,
        };
    }

    async _gpuSuspended(c) {
        try {
            const status = (await readText(`${this._gpu.dev}/power/runtime_status`, c)).trim();
            return status === 'suspended';
        } catch {
            return false;
        }
    }

    async _sampleGpu(c) {
        const gpu = this._gpu;
        if (!gpu) {
            this.snapshot.gpu = null;
            return;
        }

        // Never wake a runtime-suspended discrete GPU just to read it.
        if (await this._gpuSuspended(c)) {
            this._nvidia?.stop();
            this.snapshot.gpu = {name: 'GPU', usage: 0, temp: null, vramUsed: null, vramTotal: null, suspended: true};
            return;
        }

        if (gpu.kind === 'nvidia') {
            this._nvidia.ensure(Math.max(500, this._interval));
            const l = this._nvidia.latest;
            this.snapshot.gpu = l ? {...l, suspended: false} : null;
            return;
        }

        const [usage, temp, vramUsed, vramTotal] = await Promise.all([
            readNumber(gpu.busy, c).catch(() => null),
            gpu.temp ? readNumber(gpu.temp, c).catch(() => null) : null,
            readNumber(gpu.vramUsed, c).catch(() => null),
            readNumber(gpu.vramTotal, c).catch(() => null),
        ]);
        this.snapshot.gpu = {
            name: 'AMD GPU',
            usage,
            temp: temp === null ? null : temp / 1000,
            vramUsed,
            vramTotal,
            suspended: false,
        };
    }

    async _sampleSystem(c) {
        const [load, uptime] = await Promise.all([
            readText('/proc/loadavg', c),
            readText('/proc/uptime', c),
        ]);
        this.snapshot.system = {
            load: load.trim().split(/\s+/).slice(0, 3).map(Number),
            uptime: Number(uptime.trim().split(/\s+/)[0]),
        };
    }

    destroy() {
        this._cancellable.cancel();
        this._nvidia?.stop();
        this._nvidia = null;
    }
}
