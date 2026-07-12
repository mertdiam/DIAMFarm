// Unit tests for server/lib/headerParser.js against the synthetic fixtures under
// server/tests/fixtures/gcode/. Each fixture is built strictly from the verbatim
// examples in docs/internal/header-parser-spec.md, so these assertions prove the
// parser matches the documented format exactly. They do NOT prove the documented
// format is what a current slicer install writes today: real sliced files must be
// collected and added before this parser is trusted against hardware (spec section 8).

const path = require('path');
const { parseHeader } = require('../lib/headerParser');

const FIX = path.join(__dirname, 'fixtures', 'gcode');
const fixture = (name) => path.join(FIX, name);

describe('parseHeader: ASCII G-code fixtures', () => {
  test('Bambu Studio, BBL target (header + config at top)', async () => {
    const r = await parseHeader(fixture('bambu_bbl.gcode'));
    expect(r.format).toBe('gcode');
    expect(r.slicer).toBe('BambuStudio');
    expect(r.slicer_version).toBe('01.10.01.50');
    expect(r.printer_model).toBe('Bambu Lab A1 mini');
    expect(r.printer_model_id).toBeNull(); // gcode CONFIG_BLOCK has no machine code
    expect(r.nozzle_diameters).toEqual([0.4]);
    expect(r.filament_types).toEqual(['PLA']);
    expect(r.filament_colors).toEqual(['#ECA514FF']); // alpha preserved, casing untouched
    expect(r.estimated_time_s).toBe(369); // "6m 9s"
    expect(r.layer_height_mm).toBe(0.2);
    expect(r.total_layers).toBe(1);
    expect(r.filament_used_g).toEqual([0.06]);
    expect(r.filament_used_mm).toEqual([20.12]);
    expect(r.warnings).toEqual([]);
  });

  test('OrcaSlicer, BBL target (multi-filament, header + config at top)', async () => {
    const r = await parseHeader(fixture('orca_bbl.gcode'));
    expect(r.format).toBe('gcode');
    expect(r.slicer).toBe('OrcaSlicer');
    expect(r.slicer_version).toBe('2.3.1');
    expect(r.printer_model).toBe('Bambu Lab X1 Carbon');
    expect(r.nozzle_diameters).toEqual([0.4]);
    expect(r.filament_types).toEqual(['PLA', 'PETG']); // semicolon-joined
    expect(r.filament_colors).toEqual(['#ECA514FF', '#0000FFFF']);
    expect(r.estimated_time_s).toBe(369);
    expect(r.layer_height_mm).toBe(0.2);
    expect(r.total_layers).toBe(42);
    expect(r.filament_used_g).toEqual([0.06]);
    expect(r.filament_used_mm).toEqual([20.12]);
    expect(r.warnings).toEqual([]);
  });

  test('OrcaSlicer, non-BBL target (config only at EOF, no head config block)', async () => {
    const r = await parseHeader(fixture('orca_non_bbl.gcode'));
    expect(r.format).toBe('gcode');
    expect(r.slicer).toBe('OrcaSlicer');
    expect(r.slicer_version).toBe('2.3.1');
    expect(r.printer_model).toBe('Voron 2.4 300');
    expect(r.nozzle_diameters).toEqual([0.4]);
    expect(r.filament_types).toEqual(['PLA']);
    expect(r.filament_colors).toEqual(['#00FF00']); // #RRGGBB, no alpha
    expect(r.estimated_time_s).toBe(480); // "8m 0s"
    expect(r.layer_height_mm).toBe(0.2);
    expect(r.total_layers).toBe(120);
    expect(r.filament_used_g).toEqual([3.42]);
    expect(r.filament_used_mm).toEqual([]); // non-BBL Orca reports no [mm] line
    expect(r.warnings).toEqual([]);
  });

  test('PrusaSlicer (everything at EOF, combined filament line, no layer count key)', async () => {
    const r = await parseHeader(fixture('prusaslicer.gcode'));
    expect(r.format).toBe('gcode');
    expect(r.slicer).toBe('PrusaSlicer');
    expect(r.slicer_version).toBe('2.9.0');
    expect(r.printer_model).toBe('NEPTUNE3PRO');
    expect(r.nozzle_diameters).toEqual([0.4]);
    expect(r.filament_types).toEqual(['PLA']);
    expect(r.filament_colors).toEqual([]); // Prusa fixture has no colour key
    expect(r.estimated_time_s).toBe(802); // "13m 22s"
    expect(r.layer_height_mm).toBe(0.2);
    expect(r.total_layers).toBeNull(); // no dedicated key in PrusaSlicer output
    // Combined line "; filament used [mm] = 496.91 / 1.19 / 1.49 / 0.08": mm first, g third.
    expect(r.filament_used_mm).toEqual([496.91]);
    expect(r.filament_used_g).toEqual([1.49]);
    expect(r.warnings).toContain('PrusaSlicer output has no total layer count key; total_layers left null.');
  });

  test('third-party / stripped gcode (Cura-style, no recognized markers)', async () => {
    const r = await parseHeader(fixture('thirdparty_cura.gcode'));
    expect(r.format).toBe('gcode');
    expect(r.slicer).toBeNull();
    expect(r.slicer_version).toBeNull();
    expect(r.printer_model).toBeNull();
    expect(r.nozzle_diameters).toEqual([]);
    expect(r.filament_types).toEqual([]);
    expect(r.filament_colors).toEqual([]);
    expect(r.estimated_time_s).toBeNull();
    expect(r.layer_height_mm).toBeNull();
    expect(r.total_layers).toBeNull();
    expect(r.filament_used_g).toEqual([]);
    expect(r.filament_used_mm).toEqual([]);
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0]).toMatch(/not recognized/i);
  });

  test('bgcode stub (GCDE magic bytes only, never parsed)', async () => {
    const r = await parseHeader(fixture('bgcode_stub.bgcode'));
    expect(r.format).toBe('bgcode');
    expect(r.slicer).toBeNull();
    expect(r.printer_model).toBeNull();
    expect(r.estimated_time_s).toBeNull();
    expect(r.nozzle_diameters).toEqual([]);
    expect(r.filament_used_g).toEqual([]);
    expect(r.filament_used_mm).toEqual([]);
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0]).toMatch(/binary g-code/i);
  });
});

describe('parseHeader: 3MF fixtures', () => {
  test('sliced .gcode.3mf (slice_info plate + project_settings + plate gcode fallback)', async () => {
    const r = await parseHeader(fixture('sliced_bambu.gcode.3mf'));
    expect(r.format).toBe('3mf');
    // slicer/version and total_layers come from the plate gcode fallback
    expect(r.slicer).toBe('BambuStudio');
    expect(r.slicer_version).toBe('01.10.01.50');
    expect(r.printer_model).toBe('Bambu Lab A1 mini'); // human name from project_settings
    expect(r.printer_model_id).toBe('N1'); // machine code from slice_info
    expect(r.nozzle_diameters).toEqual([0.4]);
    expect(r.filament_types).toEqual(['PLA']);
    expect(r.filament_colors).toEqual(['#FFFFFF']);
    expect(r.estimated_time_s).toBe(369); // prediction, already whole seconds
    expect(r.layer_height_mm).toBe(0.2);
    expect(r.total_layers).toBe(25);
    expect(r.filament_used_g).toEqual([19.1]);
    // used_m="6.40" meters converted to millimeters
    expect(r.filament_used_mm).toEqual([6400]);
    expect(r.warnings).toEqual([]);
  });

  test('unsliced .3mf (slice_info has no <plate>; config-only from project_settings)', async () => {
    const r = await parseHeader(fixture('unsliced_bambu.3mf'));
    expect(r.format).toBe('3mf');
    expect(r.printer_model).toBe('Bambu Lab A1');
    expect(r.printer_model_id).toBeNull(); // no plate, no machine code
    expect(r.nozzle_diameters).toEqual([0.4]);
    expect(r.filament_types).toEqual(['PETG']);
    expect(r.filament_colors).toEqual(['#808080']);
    expect(r.layer_height_mm).toBe(0.16);
    // Plate-derived fields have no source in an unsliced project
    expect(r.estimated_time_s).toBeNull();
    expect(r.total_layers).toBeNull();
    expect(r.filament_used_g).toEqual([]);
    expect(r.filament_used_mm).toEqual([]);
  });
});

describe('parseHeader: never-throws contract', () => {
  test('a directory path resolves to a null-filled unknown result, not a throw', async () => {
    const r = await parseHeader(FIX);
    expect(r.format).toBe('unknown');
    expect(r.slicer).toBeNull();
    expect(r.warnings.length).toBe(1);
  });

  test('a nonexistent path resolves to a null-filled unknown result, not a throw', async () => {
    const r = await parseHeader(path.join(FIX, 'does-not-exist.gcode'));
    expect(r.format).toBe('unknown');
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0]).toMatch(/failed/i);
  });

  test('a corrupt zip keeps the already-detected 3mf format and adds a warning', async () => {
    const r = await parseHeader(fixture('corrupt.3mf'));
    expect(r.format).toBe('3mf'); // PK magic detected before the read error
    expect(r.slicer).toBeNull();
    expect(r.printer_model).toBeNull();
    expect(r.nozzle_diameters).toEqual([]);
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0]).toMatch(/failed/i);
  });
});

// Exercises the d/h/m/s -> whole-seconds conversion and the meters -> millimeters
// conversion via the exact source strings the spec quotes, independent of file I/O,
// so a regression in either conversion is caught here in isolation.
describe('parseHeader: conversion cases (via fixtures)', () => {
  test('dhms conversions match spec examples', async () => {
    expect((await parseHeader(fixture('bambu_bbl.gcode'))).estimated_time_s).toBe(6 * 60 + 9);      // 6m 9s
    expect((await parseHeader(fixture('orca_non_bbl.gcode'))).estimated_time_s).toBe(8 * 60);        // 8m 0s
    expect((await parseHeader(fixture('prusaslicer.gcode'))).estimated_time_s).toBe(13 * 60 + 22);   // 13m 22s
    expect((await parseHeader(fixture('sliced_bambu.gcode.3mf'))).estimated_time_s).toBe(369);       // prediction, integer seconds
  });

  test('3MF used_m meters convert to millimeters (x1000)', async () => {
    const r = await parseHeader(fixture('sliced_bambu.gcode.3mf'));
    expect(r.filament_used_mm).toEqual([6.40 * 1000]);
  });
});
