// Small color helpers shared by the shell side and the preferences window.
// Colors are plain objects {r, g, b, a} with channels in the 0..1 range.

const clamp01 = v => Math.min(1, Math.max(0, v));

export const WHITE = Object.freeze({r: 1, g: 1, b: 1, a: 1});

export function parseColor(str, fallback = WHITE) {
    if (typeof str !== 'string')
        return fallback;
    const s = str.trim().toLowerCase();

    let m = s.match(/^#([0-9a-f]{3,8})$/);
    if (m) {
        let hex = m[1];
        if (hex.length === 3 || hex.length === 4)
            hex = [...hex].map(c => c + c).join('');
        if (hex.length !== 6 && hex.length !== 8)
            return fallback;
        const n = i => parseInt(hex.slice(i, i + 2), 16) / 255;
        return {r: n(0), g: n(2), b: n(4), a: hex.length === 8 ? n(6) : 1};
    }

    m = s.match(/^rgba?\(([^)]+)\)$/);
    if (m) {
        const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
        if (parts.length < 3 || parts.some(Number.isNaN))
            return fallback;
        return {
            r: clamp01(parts[0] / 255),
            g: clamp01(parts[1] / 255),
            b: clamp01(parts[2] / 255),
            a: parts.length > 3 ? clamp01(parts[3]) : 1,
        };
    }
    return fallback;
}

// Cogl.Color (GNOME 47+) exposes 0..255 integer channels.
export function fromCogl(c) {
    if (!c)
        return WHITE;
    return {r: c.red / 255, g: c.green / 255, b: c.blue / 255, a: c.alpha / 255};
}

export function withAlpha(c, alpha) {
    return {r: c.r, g: c.g, b: c.b, a: clamp01(c.a * alpha)};
}

export function toCss(c) {
    const to8 = v => Math.round(clamp01(v) * 255);
    return `rgba(${to8(c.r)}, ${to8(c.g)}, ${to8(c.b)}, ${clamp01(c.a).toFixed(3)})`;
}

export function toHex(c) {
    const h = v => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0');
    return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

function rgbToHsv({r, g, b}) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d > 0) {
        if (max === r)
            h = ((g - b) / d) % 6;
        else if (max === g)
            h = (b - r) / d + 2;
        else
            h = (r - g) / d + 4;
        h *= 60;
        if (h < 0)
            h += 360;
    }
    return {h, s: max === 0 ? 0 : d / max, v: max};
}

function hsvToRgb(h, s, v) {
    const c = v * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = v - c;
    let rgb;
    if (h < 60)
        rgb = [c, x, 0];
    else if (h < 120)
        rgb = [x, c, 0];
    else if (h < 180)
        rgb = [0, c, x];
    else if (h < 240)
        rgb = [0, x, c];
    else if (h < 300)
        rgb = [x, 0, c];
    else
        rgb = [c, 0, x];
    return {r: rgb[0] + m, g: rgb[1] + m, b: rgb[2] + m};
}

// HSV interpolation that borrows the hue of the saturated end when the other
// end is (near) grey, so white -> red goes through pinks instead of greys.
export function mixColors(base, highlight, t) {
    t = clamp01(t);
    if (t <= 0)
        return base;
    if (t >= 1)
        return highlight;

    const a = rgbToHsv(base);
    const b = rgbToHsv(highlight);
    const hueA = a.s < 0.05 ? b.h : a.h;
    const hueB = b.s < 0.05 ? hueA : b.h;
    let dh = hueB - hueA;
    if (dh > 180)
        dh -= 360;
    if (dh < -180)
        dh += 360;

    const h = (hueA + dh * t + 360) % 360;
    const s = a.s + (b.s - a.s) * t;
    const v = a.v + (b.v - a.v) * t;
    const rgb = hsvToRgb(h, s, v);
    return {...rgb, a: base.a + (highlight.a - base.a) * t};
}

// One color per resource, in the spirit of the Resources app; light shades
// of the GNOME palette so they read well on the dark panel.
export const RESOURCE_COLORS = Object.freeze({
    cpu: parseColor('#62a0ea'),      // blue
    memory: parseColor('#c061cb'),   // purple
    gpu: parseColor('#ed333b'),      // red
    disk: parseColor('#ffa348'),     // orange
    network: parseColor('#36b5b0'),  // teal
});

// Starting color of a graph for the "graph-colors" setting: the text color
// (default), the system accent, or the resource's own color.
export function graphBaseColor(mode, category, text, accent) {
    if (mode === 'accent' && accent)
        return accent;
    if (mode === 'resources')
        return RESOURCE_COLORS[category] ?? text;
    return text;
}
