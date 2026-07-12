'use strict';

// Slicer metadata extractor for uploaded G-code and 3MF files.
//
// Contract and format details live in docs/internal/header-parser-spec.md.
// Every format claim here traces back to that spec's source-verified dossier;
// nothing is guessed. parseHeader(filePath) never throws and never reads a whole
// file: it reads the first and last 512 KB of ASCII G-code and, for 3MF, only the
// named ZIP entries it needs (random access via yauzl, so a 200 MB 3MF costs only
// the size of the entries actually read).

const fsp   = require('fs').promises;
const yauzl = require('yauzl');

// Read window. All supported metadata lives in the first 512 KB, the last 512 KB,
// or (for 3MF) in small named ZIP entries. Must stay large enough to contain a
// full Bambu/Orca CONFIG_BLOCK (tens of KB) plus the surrounding header.
const CHUNK = 512 * 1024;

// The flat, fully-shaped result. Every key is always present; nothing is partially
// shaped. Failure is signalled by format 'unknown' plus null-filled fields, never
// by a thrown error or a missing key.
function emptyResult() {
  return {
    format: 'unknown',
    slicer: null,
    slicer_version: null,
    printer_model: null,
    printer_model_id: null,
    nozzle_diameters: [],
    filament_types: [],
    filament_colors: [],
    estimated_time_s: null,
    layer_height_mm: null,
    total_layers: null,
    filament_used_g: [],
    filament_used_mm: [],
    warnings: [],
  };
}

// ── Small value helpers ──────────────────────────────────────────────────────

function toNum(v) {
  if (v == null) return null;
  const n = parseFloat(v);
  return Number.isNaN(n) ? null : n;
}

// Float lists in gcode CONFIG_BLOCK are comma-joined (one per extruder).
function splitFloats(v) {
  return String(v).split(',').map(s => parseFloat(s.trim())).filter(n => !Number.isNaN(n));
}

// String lists in gcode CONFIG_BLOCK are semicolon-joined (one per filament slot).
function splitStrings(v) {
  return String(v).split(';').map(s => s.trim()).filter(s => s.length > 0);
}

// A CONFIG_BLOCK value containing a separator is wrapped in double quotes; strip a
// leading and trailing quote only when both are present.
function stripQuotes(v) {
  if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') return v.slice(1, -1);
  return v;
}

// d/h/m/s text to whole seconds. Format is "[Nd ][Nh ][Nm ][Ns]", each part
// optional, descending unit order (e.g. "1h 2m 3s", "6m 9s", "26s"). Returns null
// if nothing parsed. A 3MF prediction value is already integer seconds and does not
// go through here.
function parseDhms(text) {
  if (text == null) return null;
  const m = String(text).trim().match(/^(?:(\d+)d\s*)?(?:(\d+)h\s*)?(?:(\d+)m\s*)?(?:(\d+)s)?$/);
  if (!m) return null;
  if (!m[1] && !m[2] && !m[3] && !m[4]) return null;
  const d = +(m[1] || 0), h = +(m[2] || 0), mi = +(m[3] || 0), s = +(m[4] || 0);
  return d * 86400 + h * 3600 + mi * 60 + s;
}

// ── ASCII G-code extraction ──────────────────────────────────────────────────

// Build a map of "; key = value" CONFIG_BLOCK lines. Restricted to word-character
// keys so it never captures header stat lines (which use " : " or "(normal mode) =")
// that are handled by their own dedicated regexes below.
function buildConfigMap(text) {
  const map = new Map();
  const re = /^;\s*([a-zA-Z_][\w]*)\s*=\s*(.*)$/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (!map.has(m[1])) map.set(m[1], stripQuotes(m[2].trim()));
  }
  return map;
}

// Config-only fields (printer_model, nozzle, filament type/color, layer height).
// Only fills a field that is still empty/null so an earlier, more specific source
// (3MF slice_info) wins over this fallback.
function applyConfigMap(map, r) {
  if (r.printer_model == null && map.has('printer_model')) r.printer_model = map.get('printer_model');
  if (r.nozzle_diameters.length === 0 && map.has('nozzle_diameter')) r.nozzle_diameters = splitFloats(map.get('nozzle_diameter'));
  if (r.filament_types.length === 0 && map.has('filament_type')) r.filament_types = splitStrings(map.get('filament_type'));
  if (r.filament_colors.length === 0 && map.has('filament_colour')) r.filament_colors = splitStrings(map.get('filament_colour'));
  if (r.layer_height_mm == null && map.has('layer_height')) r.layer_height_mm = toNum(map.get('layer_height'));
}

function extractTime(text, r) {
  if (r.estimated_time_s != null) return;
  // Bambu/Orca BBL: "; model printing time: <dhms>; total estimated time: <dhms>"
  let m = text.match(/total estimated time:\s*([^;\n]+)/);
  if (m) {
    const s = parseDhms(m[1]);
    if (s != null) { r.estimated_time_s = s; return; }
  }
  // Non-BBL target (Bambu/Orca) and PrusaSlicer: normal-mode line only. MK3-family
  // adds a "(silent mode)" line; this regex matches only "(normal mode)".
  m = text.match(/estimated printing time \(normal mode\)\s*=\s*([^\n]+)/);
  if (m) {
    const s = parseDhms(m[1]);
    if (s != null) r.estimated_time_s = s;
  }
}

function extractLayers(text, r) {
  if (r.total_layers != null) return;
  // Head-chunk key (Bambu/Orca): "; total layer number: <int>"
  let m = text.match(/total layer number:\s*(\d+)/);
  if (m) { r.total_layers = parseInt(m[1], 10); return; }
  // Orca non-BBL EOF cross-check key: "; total layers count = <int>"
  m = text.match(/total layers count\s*=\s*(\d+)/);
  if (m) r.total_layers = parseInt(m[1], 10);
}

function extractFilamentUsed(text, r) {
  // Bambu/Orca BBL header stats (note the space before the colon).
  let m = text.match(/total filament length \[mm\]\s*:\s*([\d.]+)/);
  if (m) r.filament_used_mm = [parseFloat(m[1])];
  m = text.match(/total filament weight \[g\]\s*:\s*([\d.]+)/);
  if (m) r.filament_used_g = [parseFloat(m[1])];

  // PrusaSlicer combined line: "; filament used [mm] = <mm> / <cm3> / <g> / <cost>".
  // OrcaSlicer BBL trailing line is a single value: "; filament used [mm] = <mm>".
  if (r.filament_used_mm.length === 0 || r.filament_used_g.length === 0) {
    const pm = text.match(/^;\s*filament used \[mm\]\s*=\s*([^\n]+)/m);
    if (pm) {
      const parts = pm[1].split('/').map(s => s.trim());
      if (r.filament_used_mm.length === 0 && parts[0]) {
        const mm = parseFloat(parts[0]);
        if (!Number.isNaN(mm)) r.filament_used_mm = [mm];
      }
      // Combined Prusa line: grams is the third slash-separated value.
      if (r.filament_used_g.length === 0 && parts.length >= 3) {
        const g = parseFloat(parts[2]);
        if (!Number.isNaN(g)) r.filament_used_g = [g];
      }
    }
  }

  // Orca non-BBL / Prusa standalone grams line: "; [total ]filament used [g] = <g>".
  if (r.filament_used_g.length === 0) {
    const gm = text.match(/(?:total )?filament used \[g\]\s*=\s*([\d.]+)/);
    if (gm) r.filament_used_g = [parseFloat(gm[1])];
  }
}

// Identify the slicer from the generator line. "generated by" (Orca/Prusa) is
// checked before the bare Bambu line because OrcaSlicer is a Bambu Studio fork and
// its files can carry BambuStudio-flavored strings elsewhere.
function detectSlicerInto(text, r) {
  let m = text.match(/^;\s*generated by OrcaSlicer\s+(\S+)/m);
  if (m) { r.slicer = 'OrcaSlicer'; r.slicer_version = m[1]; return true; }
  m = text.match(/^;\s*generated by PrusaSlicer\s+(\S+)/m);
  if (m) { r.slicer = 'PrusaSlicer'; r.slicer_version = m[1]; return true; }
  m = text.match(/^;\s*BambuStudio\s+(\S+)/m);
  if (m) { r.slicer = 'BambuStudio'; r.slicer_version = m[1]; return true; }
  return false;
}

function runGcodeExtraction(text, r) {
  applyConfigMap(buildConfigMap(text), r);
  extractTime(text, r);
  extractLayers(text, r);
  extractFilamentUsed(text, r);
}

async function parseGcode(filePath, head, r) {
  if (!detectSlicerInto(head, r)) {
    r.warnings.push('G-code generator not recognized (third-party or stripped file); no metadata extracted.');
    return;
  }
  let text = head;
  // No config block in the head chunk means OrcaSlicer targeting a non-Bambu printer
  // (thumbnail occupies the head) or any PrusaSlicer file: the config block and the
  // trailing stats live at EOF, so pull in the last 512 KB and match against both.
  const headHasConfig = /CONFIG_BLOCK_START/.test(head) || /^;\s*printer_model\s*=/m.test(head);
  if (!headHasConfig) {
    const tail = await readTailString(filePath, CHUNK);
    text = head + '\n' + tail;
  }
  runGcodeExtraction(text, r);
  if (r.slicer === 'PrusaSlicer' && r.total_layers == null) {
    r.warnings.push('PrusaSlicer output has no total layer count key; total_layers left null.');
  }
}

// ── 3MF / ZIP extraction ─────────────────────────────────────────────────────

// Pull the named entry value out of a slice_info.config <metadata key="..." value="..."/>.
function metaValue(xml, key) {
  const m = xml.match(new RegExp(`key="${key}"[^>]*value="([^"]*)"`));
  return m ? m[1] : null;
}

function parseSliceInfo(xml, r) {
  const modelId = metaValue(xml, 'printer_model_id');
  if (modelId != null && r.printer_model_id == null) r.printer_model_id = modelId;

  const nozzles = metaValue(xml, 'nozzle_diameters');
  if (nozzles != null && r.nozzle_diameters.length === 0) r.nozzle_diameters = splitFloats(nozzles);

  const prediction = metaValue(xml, 'prediction');
  if (prediction != null && r.estimated_time_s == null) {
    const s = parseInt(prediction, 10);
    if (!Number.isNaN(s)) r.estimated_time_s = s;
  }

  // Per-filament elements: one <filament .../> per slot. used_m is meters; convert
  // to millimeters (x1000) for filament_used_mm.
  const fils = xml.match(/<filament\b[^>]*\/?>/g) || [];
  for (const f of fils) {
    const type  = f.match(/\btype="([^"]*)"/);
    const color = f.match(/\bcolor="([^"]*)"/);
    const usedM = f.match(/\bused_m="([^"]*)"/);
    const usedG = f.match(/\bused_g="([^"]*)"/);
    if (type)  r.filament_types.push(type[1]);
    if (color) r.filament_colors.push(color[1]);
    if (usedM) { const mm = parseFloat(usedM[1]) * 1000; if (!Number.isNaN(mm)) r.filament_used_mm.push(mm); }
    if (usedG) { const g = parseFloat(usedG[1]); if (!Number.isNaN(g)) r.filament_used_g.push(g); }
  }
}

function parseProjectSettings(json, r) {
  let obj;
  try { obj = JSON.parse(json); }
  catch { r.warnings.push('project_settings.config is not valid JSON; config fields skipped.'); return; }

  if (r.printer_model == null && typeof obj.printer_model === 'string') r.printer_model = obj.printer_model;
  if (r.nozzle_diameters.length === 0 && Array.isArray(obj.nozzle_diameter)) {
    r.nozzle_diameters = obj.nozzle_diameter.map(Number).filter(n => !Number.isNaN(n));
  }
  if (r.filament_types.length === 0 && Array.isArray(obj.filament_type)) r.filament_types = obj.filament_type.slice();
  if (r.filament_colors.length === 0 && Array.isArray(obj.filament_colour)) r.filament_colors = obj.filament_colour.slice();
  if (r.layer_height_mm == null && obj.layer_height != null) r.layer_height_mm = toNum(obj.layer_height);
}

// Alternate slicer source: 3D/3dmodel.model carries
// <metadata name="Application">BambuStudio-02.00.03.54</metadata>.
function parseAppMeta(xml, r) {
  const m = xml.match(/<metadata name="Application">([^<]+)<\/metadata>/);
  if (!m) return;
  const app = m[1].match(/^(BambuStudio|OrcaSlicer|PrusaSlicer)[-\s]?(.*)$/);
  if (app) {
    if (r.slicer == null) r.slicer = app[1];
    if (r.slicer_version == null && app[2]) r.slicer_version = app[2];
  }
}

// Fallback for a sliced 3MF: parse the plate gcode head to fill any field the config
// entries left null/empty (typically slicer, slicer_version, total_layers).
function parsePlateGcodeFallback(text, r) {
  const tmp = emptyResult();
  detectSlicerInto(text, tmp);
  runGcodeExtraction(text, tmp);

  if (r.slicer == null) r.slicer = tmp.slicer;
  if (r.slicer_version == null) r.slicer_version = tmp.slicer_version;
  if (r.printer_model == null) r.printer_model = tmp.printer_model;
  if (r.printer_model_id == null) r.printer_model_id = tmp.printer_model_id;
  if (r.estimated_time_s == null) r.estimated_time_s = tmp.estimated_time_s;
  if (r.layer_height_mm == null) r.layer_height_mm = tmp.layer_height_mm;
  if (r.total_layers == null) r.total_layers = tmp.total_layers;
  if (r.nozzle_diameters.length === 0) r.nozzle_diameters = tmp.nozzle_diameters;
  if (r.filament_types.length === 0) r.filament_types = tmp.filament_types;
  if (r.filament_colors.length === 0) r.filament_colors = tmp.filament_colors;
  if (r.filament_used_g.length === 0) r.filament_used_g = tmp.filament_used_g;
  if (r.filament_used_mm.length === 0) r.filament_used_mm = tmp.filament_used_mm;
}

// Read the named ZIP entries into a Map(name -> Buffer), each capped at maxBytes.
// yauzl's callback API is wrapped in a single promise here rather than pulling in a
// promisify dependency for three call sites.
function readZipEntries(filePath, wanted, maxBytes) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err);
      const out = new Map();
      zipfile.on('error', reject);
      zipfile.on('entry', (entry) => {
        if (!wanted.has(entry.fileName)) { zipfile.readEntry(); return; }
        zipfile.openReadStream(entry, (streamErr, stream) => {
          if (streamErr) { zipfile.readEntry(); return; }
          const chunks = [];
          let total = 0;
          stream.on('data', (c) => {
            if (total >= maxBytes) return;
            if (total + c.length > maxBytes) { chunks.push(c.subarray(0, maxBytes - total)); total = maxBytes; }
            else { chunks.push(c); total += c.length; }
          });
          stream.on('end', () => { out.set(entry.fileName, Buffer.concat(chunks)); zipfile.readEntry(); });
          stream.on('error', () => { zipfile.readEntry(); });
        });
      });
      zipfile.on('end', () => resolve(out));
      zipfile.readEntry();
    });
  });
}

async function parse3mf(filePath, r) {
  const wanted = new Set([
    'Metadata/slice_info.config',
    'Metadata/project_settings.config',
    'Metadata/plate_1.gcode',
    'Metadata/Slic3r_PE.config',
    '3D/3dmodel.model',
  ]);
  const entries = await readZipEntries(filePath, wanted, CHUNK);

  const sliceInfo       = entries.get('Metadata/slice_info.config');
  const projectSettings = entries.get('Metadata/project_settings.config');
  const slic3r          = entries.get('Metadata/Slic3r_PE.config');
  const modelXml        = entries.get('3D/3dmodel.model');
  const plateGcode      = entries.get('Metadata/plate_1.gcode');

  let sliced = false;
  if (sliceInfo) {
    const xml = sliceInfo.toString('utf8');
    // A <plate> element means the file is sliced; its absence means an unsliced
    // project or MakerWorld export (config-only fields, plate-derived fields null).
    if (/<plate\b/.test(xml)) { sliced = true; parseSliceInfo(xml, r); }
  }

  if (projectSettings) {
    parseProjectSettings(projectSettings.toString('utf8'), r);
  } else if (slic3r) {
    // PrusaSlicer 3MF: "; key = value" config lines, no slice results.
    applyConfigMap(buildConfigMap(slic3r.toString('utf8')), r);
  }

  if (modelXml) parseAppMeta(modelXml.toString('utf8'), r);

  if (sliced && plateGcode) parsePlateGcodeFallback(plateGcode.toString('utf8'), r);

  if (!sliceInfo && !projectSettings && !slic3r) {
    // Generic core-spec 3MF (e.g. a plain Fusion 360 export): nothing to extract.
    r.warnings.push('No Bambu/Prusa slicer metadata entries found in 3MF; treated as a generic 3MF.');
  }
}

// ── File sniffing ────────────────────────────────────────────────────────────

async function readHeadBuffer(filePath, len) {
  const fh = await fsp.open(filePath, 'r');
  try {
    const stat = await fh.stat();
    if (stat.isDirectory()) throw new Error('path is a directory');
    const toRead = Math.min(len, stat.size);
    const buf = Buffer.alloc(toRead);
    if (toRead > 0) await fh.read(buf, 0, toRead, 0);
    return buf;
  } finally {
    await fh.close();
  }
}

async function readTailString(filePath, len) {
  const fh = await fsp.open(filePath, 'r');
  try {
    const { size } = await fh.stat();
    const toRead = Math.min(len, size);
    const start = Math.max(0, size - toRead);
    const buf = Buffer.alloc(toRead);
    if (toRead > 0) await fh.read(buf, 0, toRead, start);
    return buf.toString('utf8');
  } finally {
    await fh.close();
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

async function parseHeader(filePath) {
  const r = emptyResult();
  try {
    const head = await readHeadBuffer(filePath, CHUNK);

    // ZIP local file header magic: proceed as 3MF.
    if (head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) {
      r.format = '3mf';
      await parse3mf(filePath, r);
      return r;
    }

    // PrusaSlicer binary G-code magic: detected only, never parsed (section 9).
    if (head.length >= 4 && head.subarray(0, 4).toString('latin1') === 'GCDE') {
      r.format = 'bgcode';
      r.warnings.push('Binary G-code (.bgcode) is detected by magic bytes only and not parsed.');
      return r;
    }

    // Everything else: ASCII G-code.
    r.format = 'gcode';
    await parseGcode(filePath, head.toString('utf8'), r);
    return r;
  } catch (err) {
    // Keep an already-detected format (e.g. a corrupt but clearly-ZIP 3MF stays
    // '3mf'); an error before any detection leaves format 'unknown'.
    r.warnings.push('Header parse failed: ' + (err && err.message ? err.message : String(err)));
    return r;
  }
}

module.exports = { parseHeader };
