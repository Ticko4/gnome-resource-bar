// System sampler: reads /proc and /sys asynchronously so the shell never
// blocks. Only depends on GLib/Gio, so it can also run under plain `gjs`.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {mountPoints, parseMounts} from './mounts.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'query_filesystem_info_async');
Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'close_async');
Gio._promisify(Gio.Subprocess.prototype, 'communicate_async');

const decoder = new TextDecoder();

// Resident memory in /proc/<pid>/stat is in pages.
const PAGE_SIZE = 4096;

async function readText(path, cancellable) {
    const [bytes] = await Gio.File.new_for_path(path).load_contents_async(cancellable);
    return decoder.decode(bytes);
}

async function readNumber(path, cancellable) {
    const n = Number((await readText(path, cancellable)).trim());
    return Number.isFinite(n) ? n : null;
}

async function readTrimmed(path, cancellable) {
    try {
        return (await readText(path, cancellable)).trim();
    } catch {
        return null;
    }
}

async function listDir(path, cancellable) {
    try {
        const enumerator = await Gio.File.new_for_path(path).enumerate_children_async(
            'standard::name', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, cancellable);
        const names = [];
        for (;;) {
            // eslint-disable-next-line no-await-in-loop
            const infos = await enumerator.next_files_async(64, GLib.PRIORITY_LOW, cancellable);
            if (infos.length === 0)
                break;
            names.push(...infos.map(info => info.get_name()));
        }
        await enumerator.close_async(GLib.PRIORITY_LOW, null);
        return names.sort();
    } catch {
        return [];
    }
}

// All of /proc/<pid>/stat in one go. Reading ~200-500 files one by one from
// the shell costs ~80 ms of CPU (a thread hop and a callback per file); a
// single `cat` in a child process costs ~17 ms and keeps the work out of the
// shell. Stat lines end with a newline, one per process.
async function readAllProcStats(cancellable) {
    const proc = Gio.Subprocess.new(['sh', '-c', 'exec cat /proc/[0-9]*/stat'],
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
    const [stdout] = await proc.communicate_async(null, cancellable);
    // Bytes, not UTF-8: process names may contain anything.
    return stdout ? decoder.decode(stdout.toArray()) : '';
}

const exists = path => GLib.file_test(path, GLib.FileTest.EXISTS);

function isCancelled(e) {
    return e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

async function findCpuTempSensor(c) {
    const base = '/sys/class/hwmon';
    const preferred = [
        ['k10temp', ['Tdie', 'Tctl']],
        ['zenpower', ['Tdie', 'Tctl']],
        ['coretemp', ['Package id 0']],
        ['cpu_thermal', []],
        ['soc_thermal', []],
        ['acpitz', []],
    ];
    const hwmons = await Promise.all((await listDir(base, c)).map(async h =>
        ({dir: `${base}/${h}`, name: await readTrimmed(`${base}/${h}/name`, c)})));

    for (const [driver, labels] of preferred) {
        const hw = hwmons.find(h => h.name === driver);
        if (!hw)
            continue;
        // eslint-disable-next-line no-await-in-loop
        const inputs = (await listDir(hw.dir, c)).filter(f => /^temp\d+_input$/.test(f));
        // eslint-disable-next-line no-await-in-loop
        const inputLabels = await Promise.all(inputs.map(f =>
            readTrimmed(`${hw.dir}/${f.replace('_input', '_label')}`, c)));
        for (const label of labels) {
            const i = inputLabels.indexOf(label);
            if (i >= 0)
                return `${hw.dir}/${inputs[i]}`;
        }
        if (inputs.length > 0)
            return `${hw.dir}/${inputs[0]}`;
    }

    // Fallback: thermal zones.
    const zones = (await listDir('/sys/class/thermal', c)).filter(z => z.startsWith('thermal_zone'));
    const types = await Promise.all(zones.map(z => readTrimmed(`/sys/class/thermal/${z}/type`, c)));
    for (const type of ['x86_pkg_temp', 'cpu-thermal', 'acpitz']) {
        const i = types.indexOf(type);
        if (i >= 0)
            return `/sys/class/thermal/${zones[i]}/temp`;
    }
    return null;
}

async function findGpu(c) {
    const cards = (await listDir('/sys/class/drm', c)).filter(card => /^card\d+$/.test(card));
    const gpus = [];
    for (const card of cards) {
        const dev = `/sys/class/drm/${card}/device`;
        // eslint-disable-next-line no-await-in-loop
        const vendor = await readTrimmed(`${dev}/vendor`, c);
        if (vendor === '0x1002') {
            // eslint-disable-next-line no-await-in-loop
            const [hwmon] = await listDir(`${dev}/hwmon`, c);
            // eslint-disable-next-line no-await-in-loop
            const vram = Number(await readTrimmed(`${dev}/mem_info_vram_total`, c) ?? 0);
            gpus.push({
                kind: 'amd',
                dev,
                busy: `${dev}/gpu_busy_percent`,
                vramUsed: `${dev}/mem_info_vram_used`,
                vramTotal: `${dev}/mem_info_vram_total`,
                temp: hwmon ? `${dev}/hwmon/${hwmon}/temp1_input` : null,
                vram,
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
        // Every discovered disk keyed by mount path, the discovery order, and
        // the mount used by disk stats that do not name one.
        disks: {},
        diskList: [],
        // Per block device (diskstats name): {util %, read, write bytes/s}.
        diskIo: {},
        // [{pid, name, cpu %, mem bytes}] while the menu lists processes.
        processes: null,
        defaultDisk: '/',
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
        this._extraDisks = new Set();
        this._prevIo = null;
        // Process CPU history: snapshots about 5 s apart covering the
        // averaging window (see _sampleProcesses).
        this._procRing = [];
        this._procLast = 0;
        this._procEvery = 5000;
        this._procWindow = 60;
        this._cpuTotal = null;
        this._ioNames = new Map();
        this._iface = '';
        this._diskStamp = 0;
        this._sources = new Set(['cpu', 'mem', 'net']);
        this._interval = 1000;

        // Sensors and GPU are found asynchronously on the first sample.
        this._discovery = null;
        this._cpuTempPath = null;
        this._cpuMaxMhz = null;
        this._gpu = null;
        this._nvidia = null;
    }

    get hasGpu() {
        return this._gpu !== null;
    }

    get gpuKind() {
        return this._gpu?.kind ?? null;
    }

    // processesEvery: ms between process readings (5000 in the background,
    // 0 = every sample while the menu is open); processesWindow: seconds the
    // CPU average covers.
    setOptions({diskPath, networkInterface, interval, processesEvery, processesWindow}) {
        if (processesEvery !== undefined)
            this._procEvery = processesEvery;
        if (processesWindow !== undefined)
            this._procWindow = processesWindow;
        if (diskPath !== undefined && (diskPath || '/') !== this.snapshot.defaultDisk) {
            this.snapshot.defaultDisk = diskPath || '/';
            this._diskStamp = 0;
        }
        if (networkInterface !== undefined && networkInterface !== this._iface) {
            this._iface = networkInterface;
            this._prevNet = null;
            this.snapshot.net = null;
        }
        if (interval !== undefined)
            this._interval = interval;
    }

    // Mount points named by panel items ("disk_used_pct:/mnt/data").
    setDiskPaths(paths) {
        const next = new Set(paths);
        if ([...next].some(p => !this._extraDisks.has(p)))
            this._diskStamp = 0;
        this._extraDisks = next;
    }

    // Forget previous readings, e.g. after a pause: the next deltas start from
    // a fresh baseline instead of averaging over the pause. Values on screen
    // stay until new ones arrive.
    reset() {
        this._prevCpu = null;
        this._prevNet = null;
        this._prevIo = null;
        this._procRing.length = 0;
        this._procLast = 0;
        this._nvidia?.stop();
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
        try {
            this._discovery ??= this._discover(c);
            await this._discovery;
        } catch (e) {
            if (!isCancelled(e))
                console.debug(`[resource-bar] discovery: ${e}`);
        }
        const want = this._sources;
        const jobs = [this._sampleCpu(c), this._sampleMem(c), this._sampleNet(c)];
        if (want.has('cpuTemp'))
            jobs.push(this._sampleCpuTemp(c));
        if (want.has('cpuFreq'))
            jobs.push(this._sampleCpuFreq(c));
        if (want.has('disk'))
            jobs.push(this._sampleDisk(c));
        if (want.has('diskio'))
            jobs.push(this._sampleDiskIo(c));
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
            // After the CPU sample, which provides this tick's total CPU time.
            if (want.has('processes')) {
                await this._sampleProcesses(c).catch(e => {
                    if (!isCancelled(e))
                        console.debug(`[resource-bar] processes: ${e}`);
                });
            } else {
                this.snapshot.processes = null;
                this._procRing.length = 0;
                this._procLast = 0;
            }
        } finally {
            this._busy = false;
        }
        return !c.is_cancelled();
    }

    async _discover(c) {
        const [tempPath, maxKhz, gpu] = await Promise.all([
            findCpuTempSensor(c),
            readTrimmed('/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq', c),
            findGpu(c),
        ]);
        this._cpuTempPath = tempPath;
        const khz = Number(maxKhz);
        this._cpuMaxMhz = Number.isFinite(khz) && khz > 0 ? khz / 1000 : null;
        this._gpu = gpu;
        this._nvidia = gpu?.kind === 'nvidia' ? new NvidiaMonitor(gpu.smi) : null;
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
        this._cpuTotal = now.cpu?.total ?? null;
        if (!prev)
            return; // first reading (or after a pause): keep what is shown
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

    // Processes with their CPU use averaged over the last `_procWindow`
    // seconds (share of all CPU time, 100% = the whole machine, like the CPU
    // card) and their current resident memory. Readings are kept about 5 s
    // apart; the average compares this reading with the oldest one in the
    // window, so it is ready as soon as the menu opens. Kernel threads are
    // skipped; processes are keyed by pid and start time, so a reused pid
    // never inherits another process's CPU time.
    async _sampleProcesses(c) {
        const t = GLib.get_monotonic_time();
        if (this._procLast && t - this._procLast < this._procEvery * 1000 - 100000)
            return;
        const total = this._cpuTotal;
        if (total === null)
            return;
        this._procLast = t;

        const procs = new Map();
        for (const line of (await readAllProcStats(c)).split('\n')) {
            // "<pid> (<name>) <state> ...": the name is between the first "("
            // and the last ")", and may itself contain spaces or parentheses.
            const open = line.indexOf('(');
            const close = line.lastIndexOf(')');
            if (open < 1 || close < open)
                continue;
            const pid = Number(line.slice(0, open));
            const f = line.slice(close + 2).split(' ');
            if (!pid || !Number(f[20])) // no address space: kernel thread
                continue;
            procs.set(`${pid}:${f[19]}`, { // pid + start time
                pid,
                name: line.slice(open + 1, close),
                ticks: Number(f[11]) + Number(f[12]), // utime + stime
                rss: Number(f[21]) * PAGE_SIZE,
            });
        }

        // Readings older than the window (or left from before a long pause,
        // e.g. "Top processes" was off) are dropped, keeping one at or
        // before the window start as the base.
        const ring = this._procRing;
        const windowStart = t - this._procWindow * 1e6;
        if (ring.length && t - ring[ring.length - 1].t > this._procWindow * 1e6)
            ring.length = 0;
        while (ring.length > 1 && ring[1].t <= windowStart)
            ring.shift();
        const base = ring[0];
        if (!ring.length || t - ring[ring.length - 1].t >= 4500000)
            ring.push({t, total, ticks: new Map([...procs].map(([k, p]) => [k, p.ticks]))});

        if (!base) {
            this.snapshot.processes = null;
            return;
        }
        const elapsed = total - base.total;
        const list = [];
        for (const [key, p] of procs) {
            // A process started inside the window has no base: count all of it.
            const used = p.ticks - (base.ticks.get(key) ?? 0);
            list.push({
                pid: p.pid,
                name: p.name,
                cpu: elapsed > 0 ? Math.max(0, 100 * used / elapsed) : 0,
                mem: p.rss,
            });
        }
        await this._fullNames(list, c);
        this.snapshot.processes = list;
    }

    // The kernel cuts process names to 15 characters ("jetbrains-toolb").
    // For the few processes the menu can show (top 5 by CPU and by memory),
    // take the full name from the command line when it extends the short one.
    async _fullNames(list, c) {
        const top = new Set([
            ...[...list].sort((a, b) => b.cpu - a.cpu).slice(0, 5),
            ...[...list].sort((a, b) => b.mem - a.mem).slice(0, 5),
        ]);
        await Promise.all([...top].filter(p => p.name.length >= 15).map(async p => {
            try {
                const argv0 = (await readText(`/proc/${p.pid}/cmdline`, c)).split('\0')[0];
                const base = GLib.path_get_basename(argv0);
                if (base.startsWith(p.name))
                    p.name = base;
            } catch {
                // exited meanwhile: keep the short name
            }
        }));
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
        if (this._diskStamp && now - this._diskStamp < 5e6)
            return;
        this._diskStamp = now;

        const text = await readText('/proc/self/mounts', c);
        const discovered = parseMounts(text);
        const mounted = mountPoints(text);
        const defaultDisk = this.snapshot.defaultDisk;
        // Items pinned to a disk only report while it is mounted, so an
        // unplugged drive shows "--" instead of the parent filesystem.
        const extra = [...this._extraDisks].filter(p => mounted.has(p));
        const paths = new Set([defaultDisk, ...extra, ...discovered.map(m => m.path)]);
        for (const m of discovered)
            m.ioName = this._ioName(m.device);
        const devices = new Map(discovered.map(m => [m.path, m]));

        const results = await Promise.all([...paths].map(path =>
            this._statfs(path, c).then(d => ({...d, device: devices.get(path)?.device ?? null}))
                .catch(() => null)));
        const disks = {};
        for (const d of results) {
            if (d)
                disks[d.path] = d;
        }
        this.snapshot.disks = disks;
        this.snapshot.diskList = discovered.filter(m => disks[m.path]);
    }

    // /proc/diskstats name of a mount's device; /dev/mapper/* are symlinks
    // to ../dm-N, so one level of resolution is enough.
    _ioName(device) {
        let name = this._ioNames.get(device);
        if (name === undefined) {
            let target = device;
            try {
                if (GLib.file_test(device, GLib.FileTest.IS_SYMLINK))
                    target = GLib.file_read_link(device);
            } catch {
                target = device;
            }
            name = GLib.path_get_basename(target);
            this._ioNames.set(device, name);
        }
        return name;
    }

    // Disk activity like iostat: share of wall time the device spent doing
    // I/O, plus read/write throughput. Cheap, and never wakes sleeping disks.
    async _sampleDiskIo(c) {
        const text = await readText('/proc/diskstats', c);
        const t = GLib.get_monotonic_time();
        const counters = {};
        for (const line of text.split('\n')) {
            const f = line.trim().split(/\s+/);
            if (f.length < 14)
                continue;
            // sectors read (6th), sectors written (10th), ms doing I/O (13th)
            counters[f[2]] = {read: Number(f[5]), write: Number(f[9]), busy: Number(f[12])};
        }
        const prev = this._prevIo;
        this._prevIo = {t, counters};
        if (!prev)
            return;
        const dt = (t - prev.t) / 1e6;
        if (dt <= 0)
            return;
        const io = {};
        for (const [name, cur] of Object.entries(counters)) {
            const old = prev.counters[name];
            if (!old)
                continue;
            io[name] = {
                util: Math.min(100, Math.max(0, (cur.busy - old.busy) / (dt * 10))),
                read: Math.max(0, (cur.read - old.read) * 512 / dt),
                write: Math.max(0, (cur.write - old.write) * 512 / dt),
            };
        }
        this.snapshot.diskIo = io;
    }

    async _statfs(path, c) {
        const info = await Gio.File.new_for_path(path).query_filesystem_info_async(
            'filesystem::size,filesystem::free,filesystem::used', GLib.PRIORITY_LOW, c);
        const total = info.get_attribute_uint64('filesystem::size');
        const avail = info.get_attribute_uint64('filesystem::free');
        const used = info.get_attribute_uint64('filesystem::used');
        const denom = used + avail;
        return {path, total, used, avail, pct: denom > 0 ? 100 * used / denom : 0};
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
