// Mounted disk discovery from /proc/self/mounts. Pure JS (shared by the
// shell sampler and the preferences window).

// Local filesystems worth showing; read-only images (iso9660, squashfs),
// network shares and pseudo filesystems are left out.
const DISK_FS = new Set([
    'ext2', 'ext3', 'ext4', 'btrfs', 'xfs', 'f2fs', 'bcachefs', 'zfs',
    'vfat', 'exfat', 'ntfs', 'ntfs3', 'fuseblk', 'jfs', 'reiserfs', 'nilfs2', 'hfsplus',
]);

// System-internal mount points that only add noise.
const HIDDEN_PREFIXES = ['/boot', '/efi', '/snap/', '/var/lib/', '/sysroot', '/proc', '/sys', '/dev'];

function unescapeMount(s) {
    return s.replace(/\\([0-7]{3})/g, (_m, oct) => String.fromCharCode(parseInt(oct, 8)));
}

function isHidden(path) {
    if (path.startsWith('/run/') && !path.startsWith('/run/media/'))
        return true;
    return HIDDEN_PREFIXES.some(p => path === p || path.startsWith(p.endsWith('/') ? p : `${p}/`));
}

// Returns [{path, device, fstype}] with one entry per filesystem: btrfs
// subvolumes (/ and /home on the same partition) collapse into the shortest
// mount path. "/" always comes first, the rest sorted by path.
export function parseMounts(text) {
    const byDevice = new Map();
    for (const line of text.split('\n')) {
        const [rawDevice, rawPath, fstype] = line.split(' ');
        if (!rawPath || !DISK_FS.has(fstype))
            continue;
        const device = unescapeMount(rawDevice);
        const path = unescapeMount(rawPath);
        if (fstype !== 'zfs' && !device.startsWith('/dev/'))
            continue;
        if (device.startsWith('/dev/loop') || device.startsWith('/dev/zram') || isHidden(path))
            continue;
        const prev = byDevice.get(device);
        if (!prev || path.length < prev.path.length)
            byDevice.set(device, {path, device, fstype});
    }
    return [...byDevice.values()].sort((a, b) => {
        if (a.path === '/')
            return -1;
        if (b.path === '/')
            return 1;
        return a.path.localeCompare(b.path);
    });
}

// Short name for a mount point: "/" stays "/", "/mnt/KIOXIA-SSD" -> "KIOXIA-SSD".
export function mountName(path) {
    if (!path || path === '/')
        return '/';
    const parts = path.split('/').filter(Boolean);
    return parts[parts.length - 1] ?? path;
}

// Every mount point in /proc/self/mounts, filtered or not.
export function mountPoints(text) {
    const out = new Set();
    for (const line of text.split('\n')) {
        const path = line.split(' ')[1];
        if (path)
            out.add(unescapeMount(path));
    }
    return out;
}
