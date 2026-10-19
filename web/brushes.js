'use strict';
// Brushes: each turns a drawn gesture (points [x, y, pressure] in drawing mm) into the lines the plotter will draw.
// Sizes in a brush's settings are paper millimetres; `k` converts them to drawing mm (1 / the drawing's scale), and
// `rotate` is the drawing's rotation in degrees, so hatch angles stay true to the paper.

const BRUSH_TYPES = {
  pen: 'Pen - the line as drawn',
  hatch: 'Hatch fill',
  crosshatch: 'Cross-hatch',
  scribble: 'Scribble (zigzag)',
  circles: 'Circles (circulism)',
  rake: 'Rake (parallel lines)',
  sketchy: 'Sketchy (loose lines)',
  stars: 'Stars (5-pointed)',
};

function defaultBrush() {
  return {
    type: 'pen',
    area: 'sweep',        // Hatch and cross-hatch: 'sweep' paints a band; 'outline' fills the shape you draw around
    width: 8,             // Sweep width, mm
    angle: 45,            // Hatch angle, degrees from horizontal
    spacingLight: 2,      // Hatch spacing for a light touch, mm
    spacingFirm: 0.6,     // ... and for full pressure
    crossSpacing: 1.2,    // Cross-hatch spacing, mm
    maxDirections: 3,     // Cross-hatch: firmer pressure adds directions, up to this many (2-4)
    join: true,           // Join neighbouring hatch lines into back-and-forth strokes (fewer pen lifts)
    scribbleWidth: 4,     // Zigzag width at full pressure, mm
    pitch: 0.8,           // Zigzag pitch, mm
    circleSize: 2,        // Circle diameter, mm
    circlePitchLight: 1.2, // How far each circle moves on for a light touch, mm (smaller = denser)
    circlePitchFirm: 0.3,
    tines: 4,             // Rake lines
    tineSpacing: 1,       // Rake spacing for a light touch, mm (doubles at full pressure)
    sketchLines: 2,       // Sketchy: lines per stroke
    wobble: 0.4,          // Sketchy: how far the lines stray, mm
    starSize: 6,          // Star width at full pressure, mm (a light touch makes them 40% of this)
    starSpacing: 8,       // Distance between stars along the stroke, mm
    starStyle: 'outline', // 'outline' (the star's edge) or 'pentagram' (five crossing lines)
    starTumble: true,     // Turn each star a little at random; otherwise they point along the stroke
  };
}

const Brushes = (() => {
  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

  // Small seeded random numbers, so a stroke's look doesn't change each time it's drawn
  function rng(seedText) {
    let h = 2166136261;
    for (const c of String(seedText)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    return () => {
      h = (h + 0x6d2b79f5) | 0;
      let t = Math.imul(h ^ (h >>> 15), 1 | h);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Evenly spaced points along the gesture, with pressure interpolated, and the distance along it
  function resample(pts, step) {
    if (pts.length < 2) return pts.length ? [{ x: pts[0][0], y: pts[0][1], p: pts[0][2], s: 0 }] : [];
    const out = [{ x: pts[0][0], y: pts[0][1], p: pts[0][2], s: 0 }];
    let carried = 0, s = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], len = dist(a, b);
      if (len === 0) continue;
      let t = step - carried;
      while (t <= len) {
        const f = t / len;
        s += step;
        out.push({ x: lerp(a[0], b[0], f), y: lerp(a[1], b[1], f), p: lerp(a[2], b[2], f), s });
        t += step;
      }
      carried = len - (t - step);
    }
    const last = pts[pts.length - 1], end = out[out.length - 1];
    if (dist([end.x, end.y], last) > step * 0.25) out.push({ x: last[0], y: last[1], p: last[2], s: s + carried });
    return out;
  }

  // Unit normals along resampled points, from a smoothed direction so small wobbles don't flip them
  function normals(samples, reach = 3) {
    return samples.map((_, i) => {
      const a = samples[Math.max(0, i - reach)], b = samples[Math.min(samples.length - 1, i + reach)];
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
      return len ? [-dy / len, dx / len] : [0, 1];
    });
  }

  const average = (pts) => pts.reduce((sum, pt) => sum + pt[2], 0) / pts.length;

  // ----- Hatching -----

  // Parallel lines at `angle` (paper degrees) spaced `spacing` apart, inside the region. Lines sit on a fixed grid, so
  // separate strokes line up. Returns polylines [x, y, p].
  function hatchLines(pts, b, k, rotate, angle, spacing, pressure) {
    const theta = ((angle - rotate) * Math.PI) / 180;
    const cos = Math.cos(theta), sin = Math.sin(theta);
    const toR = (x, y) => [x * cos + y * sin, -x * sin + y * cos];   // Hatch lines become horizontal
    const fromR = (u, v) => [u * cos - v * sin, u * sin + v * cos];
    const gap = spacing * k;

    // Each hatch line's covered intervals [u0, u1] at height v
    let intervalsAt, vMin, vMax;
    if (b.area === 'outline' && pts.length >= 3) {
      const poly = pts.map((pt) => toR(pt[0], pt[1]));
      vMin = Math.min(...poly.map((q) => q[1]));
      vMax = Math.max(...poly.map((q) => q[1]));
      intervalsAt = (v) => {
        const xs = [];
        for (let i = 0; i < poly.length; i++) {
          const a = poly[i], c = poly[(i + 1) % poly.length];
          if ((a[1] <= v && c[1] > v) || (c[1] <= v && a[1] > v)) xs.push(a[0] + ((v - a[1]) / (c[1] - a[1])) * (c[0] - a[0]));
        }
        xs.sort((p, q) => p - q);
        const out = [];
        for (let i = 0; i + 1 < xs.length; i += 2) out.push([xs[i], xs[i + 1]]);
        return out;
      };
    } else {
      // A band: every point within half the width of the path (discs along it, merged)
      const r = (b.width / 2) * k;
      const discs = resample(pts, Math.min(0.5 * k, r / 3)).map((q) => toR(q.x, q.y));
      vMin = Math.min(...discs.map((q) => q[1])) - r;
      vMax = Math.max(...discs.map((q) => q[1])) + r;
      intervalsAt = (v) => {
        const spans = [];
        for (const [u, w] of discs) {
          const dv = w - v;
          if (Math.abs(dv) <= r) { const h = Math.sqrt(r * r - dv * dv); spans.push([u - h, u + h]); }
        }
        spans.sort((p, q) => p[0] - q[0]);
        const merged = [];
        for (const s of spans) {
          const last = merged[merged.length - 1];
          if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]); else merged.push(s.slice());
        }
        return merged.filter((s) => s[1] - s[0] > 0.05 * k);
      };
    }

    // Back-and-forth: each line runs the opposite way to the one before; with "join", neighbouring lines connect
    const chains = [];
    let open = [];
    const first = Math.ceil(vMin / gap), last = Math.floor(vMax / gap);
    for (let i = first; i <= last; i++) {
      const v = i * gap, forward = i % 2 === 0;
      const spans = intervalsAt(v);
      if (!forward) spans.reverse();
      const next = [];
      for (const [u0, u1] of spans) {
        const start = forward ? [u0, v] : [u1, v], end = forward ? [u1, v] : [u0, v];
        let chain = null;
        if (b.join) {
          let best = 3 * gap;
          for (const c of open) {
            if (c.used) continue;
            const d = dist(c.pts[c.pts.length - 1], start);
            if (d < best) { best = d; chain = c; }
          }
        }
        if (chain) { chain.used = true; chain.pts.push(start, end); }
        else { chain = { pts: [start, end] }; chains.push(chain); }
        next.push(chain);
      }
      for (const c of next) c.used = false;
      open = next;
    }
    return chains.map((c) => c.pts.map(([u, v]) => [...fromR(u, v), pressure]));
  }

  function hatch(pts, b, k, rotate) {
    const p = clamp01(average(pts));
    return hatchLines(pts, b, k, rotate, b.angle, lerp(b.spacingLight, b.spacingFirm, p), p);
  }

  function crosshatch(pts, b, k, rotate) {
    const p = clamp01(average(pts));
    const directions = [0, 90, 45, -45].slice(0, Math.max(2, Math.min(4, b.maxDirections)));
    const count = Math.max(1, Math.min(directions.length, Math.ceil(p * directions.length)));
    return directions.slice(0, count).flatMap((d) => hatchLines(pts, b, k, rotate, b.angle + d, b.crossSpacing, p));
  }

  // ----- Along the stroke -----

  // A zigzag across the stroke, wider where you press harder - one continuous line
  function scribble(pts, b, k) {
    const samples = resample(pts, (b.pitch / 2) * k);
    if (samples.length < 2) return [];
    const ns = normals(samples);
    return [samples.map((q, i) => {
      const amp = (b.scribbleWidth / 2) * k * (0.25 + 0.75 * clamp01(q.p));
      const side = i % 2 === 0 ? 1 : -1;
      return [q.x + ns[i][0] * amp * side, q.y + ns[i][1] * amp * side, q.p];
    })];
  }

  // Small overlapping loops travelling along the stroke (circulism); firmer pressure packs them closer
  function circles(pts, b, k, rotate, seed) {
    const samples = resample(pts, 0.1 * k);
    const random = rng(seed);
    const total = samples.length ? samples[samples.length - 1].s : 0;
    const at = (s) => {
      if (samples.length === 1) return samples[0];
      let lo = 0, hi = samples.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (samples[mid].s <= s) lo = mid; else hi = mid; }
      const a = samples[lo], c = samples[hi], f = c.s > a.s ? clamp01((s - a.s) / (c.s - a.s)) : 0;
      return { x: lerp(a.x, c.x, f), y: lerp(a.y, c.y, f), p: lerp(a.p, c.p, f) };
    };
    const steps = 20, out = [];
    let s = 0, phi = random() * Math.PI * 2, radius = (b.circleSize / 2) * k;
    do {
      for (let j = 0; j < steps; j++) {
        const c = at(Math.min(s, total));
        if (j === 0) radius = (b.circleSize / 2) * k * (0.85 + 0.3 * random()); // A little irregular, like by hand
        out.push([c.x + radius * Math.cos(phi), c.y + radius * Math.sin(phi), c.p]);
        phi += (Math.PI * 2) / steps;
        s += (lerp(b.circlePitchLight, b.circlePitchFirm, clamp01(c.p)) * k) / steps;
      }
    } while (s < total);
    out.push(out[out.length - steps]); // Close the last loop
    return [out];
  }

  // Several parallel lines following the stroke, spreading apart with pressure
  function rake(pts, b, k) {
    const samples = resample(pts, 0.3 * k);
    if (samples.length < 2) return [];
    const ns = normals(samples);
    const n = Math.max(2, Math.round(b.tines));
    const lines = [];
    for (let j = 0; j < n; j++) {
      const offset = j - (n - 1) / 2;
      lines.push(samples.map((q, i) => {
        const d = offset * b.tineSpacing * k * (1 + clamp01(q.p));
        return [q.x + ns[i][0] * d, q.y + ns[i][1] * d, q.p];
      }));
    }
    return lines;
  }

  // The stroke drawn a few times, each straying a little and over- or under-shooting its ends, like a quick sketch
  function sketchy(pts, b, k, rotate, seed) {
    const samples = resample(pts, 0.3 * k);
    if (samples.length < 2) return [];
    const ns = normals(samples, 5);
    const random = rng(seed);
    const lines = [];
    for (let j = 0; j < Math.max(1, Math.round(b.sketchLines)); j++) {
      const waves = [0, 1, 2].map(() => ({ f: (0.15 + random() * 0.5) / k, phase: random() * Math.PI * 2, a: 0.4 + random() * 0.6 }));
      const norm = waves.reduce((sum, w) => sum + w.a, 0);
      const drift = (s) => (b.wobble * k * waves.reduce((sum, w) => sum + w.a * Math.sin(s * w.f + w.phase), 0)) / norm;
      const line = samples.map((q, i) => [q.x + ns[i][0] * drift(q.s), q.y + ns[i][1] * drift(q.s), q.p]);
      // Over- or under-shoot each end by up to about 1 mm
      const extend = (end, before) => {
        const len = (random() * 2 - 0.6) * k;
        const dx = end[0] - before[0], dy = end[1] - before[1], d = Math.hypot(dx, dy) || 1;
        return [end[0] + (dx / d) * len, end[1] + (dy / d) * len, end[2]];
      };
      line.unshift(extend(line[0], line[Math.min(3, line.length - 1)]));
      line.push(extend(line[line.length - 1], line[Math.max(0, line.length - 4)]));
      lines.push(line);
    }
    return lines;
  }

  // Five-pointed stars placed along the stroke, bigger where you press harder. Each is one continuous line, so the
  // pen lands once per star.
  function stars(pts, b, k, rotate, seed) {
    const samples = resample(pts, 0.2 * k);
    if (!samples.length) return [];
    const random = rng(seed);
    const total = samples[samples.length - 1].s, gap = Math.max(0.5, b.starSpacing) * k;
    const ns = normals(samples);
    const out = [];
    let i = 0;
    for (let s = 0; s <= total + 1e-9; s += gap) {
      while (i < samples.length - 1 && samples[i + 1].s <= s) i++;
      const q = samples[i];
      const radius = (b.starSize / 2) * k * (0.4 + 0.6 * clamp01(q.p));
      // Upright on the paper, or pointing along the stroke, plus a little turn at random if tumbling
      const along = samples.length > 1 ? Math.atan2(-ns[i][0], ns[i][1]) : 0;
      const base = (b.starTumble ? -Math.PI / 2 - (rotate * Math.PI) / 180 + (random() - 0.5) * 0.9 : along);
      const tip = (j) => [q.x + radius * Math.cos(base + (j * 2 * Math.PI) / 5), q.y + radius * Math.sin(base + (j * 2 * Math.PI) / 5), q.p];
      let star;
      if (b.starStyle === 'pentagram') {
        star = [0, 2, 4, 1, 3, 0].map(tip);
      } else {
        const inner = radius * 0.382; // The inner points of a regular star
        star = [];
        for (let j = 0; j <= 10; j++) {
          const a = base + (j * Math.PI) / 5, r = j % 2 ? inner : radius;
          star.push([q.x + r * Math.cos(a), q.y + r * Math.sin(a), q.p]);
        }
      }
      out.push(star);
    }
    return out;
  }

  const generators = { hatch, crosshatch, scribble, circles, rake, sketchy, stars };

  return {
    // Lines for a gesture with a brush: polylines of [x, y, pressure] in drawing mm
    generate(brush, pts, { k = 1, rotate = 0, seed = '' } = {}) {
      const make = generators[brush.type];
      if (!make || !pts.length) return [pts];
      return make(pts, brush, k, rotate, seed).filter((line) => line.length > 1);
    },
    resample,
    // Brushes that fill an area, rather than following the stroke
    fillsArea: (brush) => brush.type === 'hatch' || brush.type === 'crosshatch',
  };
})();
