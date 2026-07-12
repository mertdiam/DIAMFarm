# Header Parser Implementation Spec (Task 4, Stage 1)

This is the implementation contract for `server/lib/headerParser.js`, a new module that extracts slicer metadata from an uploaded G-code or 3MF file. Stage 2 (bulk tier) implements this module and its test suite against the fixtures described in section 8; this document is the spec it must follow exactly. Every format claim below is taken from the source-verified research dossier compiled for this task (real slicer output plus, where noted, official spec text); nothing here is filled in from memory of slicer internals.

Internal doc, not part of the public docs index: this file documents an unreleased module for the DIAM fork and is not linked from `docs/README.md`, which indexes public-facing documentation only.

---

## 1. Purpose

On G-code or 3MF upload, extract the following for display in the upload UI and for later dispatch matching (matching itself is out of scope, see section 9):

- Printer model (human-readable, and the internal Bambu model code where available)
- Nozzle diameter(s)
- Filament type(s)
- Filament color(s)
- Estimated print time, in whole seconds
- Layer height
- Total layer count
- Filament used, in grams and in millimeters

**The parser must never block or fail an upload.** Any read error, unrecognized format, or missing field set results in an all-null result for the affected fields plus a `format` tag describing what was detected (or `unknown` if nothing was recognized). The calling route wraps the parser call so that a thrown exception is treated the same as a null result: the upload proceeds either way.

## 2. Public API

```js
async function parseHeader(filePath)
```

Single exported async function. Takes the absolute path to the uploaded file already on disk. Returns a flat plain object, always with every key present (never partially shaped), using snake_case field names to match this codebase's DB and route conventions.

| Field | Type | Notes |
|---|---|---|
| `format` | `'gcode' \| '3mf' \| 'bgcode' \| 'unknown'` | Always set, even on total failure. |
| `slicer` | `string \| null` | `'BambuStudio'`, `'OrcaSlicer'`, `'PrusaSlicer'`, or `null` if not identified. |
| `slicer_version` | `string \| null` | Verbatim version string from the generator line, e.g. `'01.10.01.50'` or `'2.3.1'`. |
| `printer_model` | `string \| null` | Human-readable model, e.g. `'Bambu Lab A1 mini'`. |
| `printer_model_id` | `string \| null` | Bambu internal machine code, e.g. `'N1'`. Only populated from 3MF `slice_info.config`; gcode CONFIG_BLOCK has no equivalent key. |
| `nozzle_diameters` | `number[]` | One entry per extruder/nozzle. Empty array if absent. |
| `filament_types` | `string[]` | One entry per filament slot in use. Empty array if absent. |
| `filament_colors` | `string[]` | Hex strings as written by the slicer (`#RRGGBB` or `#RRGGBBAA`), one per filament slot. Empty array if absent. |
| `estimated_time_s` | `integer \| null` | Whole seconds. Converted from `d/h/m/s` text where the source is textual; already an integer where the source is 3MF `prediction`. |
| `layer_height_mm` | `number \| null` | |
| `total_layers` | `integer \| null` | See section 6 for which sources legitimately omit this. |
| `filament_used_g` | `number[]` | One entry per filament when the source is per-filament (3MF); a single-element array when the source only reports a file total (gcode trailing stats). Empty array if absent. |
| `filament_used_mm` | `number[]` | Same shape as `filament_used_g`. 3MF values are converted from meters to millimeters (see section 5). |
| `warnings` | `string[]` | Human-readable notes about anything unusual encountered while parsing (unexpected structure, a section that could not be read, a unit anomaly). Empty array in the normal case. Never used to signal failure; failure is `format: 'unknown'` plus null-filled fields. |

No other keys. No nested objects. No thrown errors escape `parseHeader`; every internal failure is caught and folded into the null-filled result plus a `warnings` entry.

## 3. Detection and Read Strategy

Never read a whole file into memory. All metadata for every supported format lives in the first 512 KB, the last 512 KB, or (for 3MF) in specific small ZIP entries read by name.

1. **Sniff the first 8 bytes.**
   - `PK\x03\x04` → ZIP container, proceed as 3MF (section 3.2).
   - `GCDE` → PrusaSlicer binary G-code (`.bgcode`). Bail out immediately: set `format: 'bgcode'`, null-fill every other field, add a warning that binary G-code is not parsed. Do not attempt any ASCII scan; a `.bgcode` file has no ASCII header to find.
   - Anything else → treat as ASCII G-code (section 3.3).

2. **3MF / ZIP path.**
   - Open the ZIP centrally (see section 7 on `yauzl`): read the End Of Central Directory and central directory records, not the whole file. This gives random access to named entries regardless of file size, and handles ZIP64 (Bambu 3MF files use it once large enough).
   - Read `Metadata/slice_info.config` first. If it contains a `<plate>` element, the file is sliced; extract per section 4's 3MF table.
   - If `slice_info.config` has no `<plate>` (unsliced project or MakerWorld 3MF), or the entry is entirely absent (generic core-spec 3MF with no `Metadata/*.config` at all, e.g. exported from Fusion), fall back to `Metadata/project_settings.config` for the config-only fields (printer model, nozzle, filament type/color, layer height) and leave the plate-derived fields (`estimated_time_s`, filament used, total layer count) null.
   - If both are informative but the file was actually sliced and a `Metadata/plate_1.gcode` entry exists, that entry may be streamed (first 512 KB only, same reader as section 3.3) to fill any field the config files left null. This is a fallback path, not the primary path: prefer `slice_info.config` and `project_settings.config` first since they are far smaller reads.
   - `Metadata/model_settings.config` enumerates plates via `<metadata key="gcode_file" value="Metadata/plate_1.gcode"/>`; use it only if multiple plates need to be distinguished. Stage 1 scope is single-plate extraction (first plate found); multi-plate is not required for this PR.
   - PrusaSlicer 3MF (`Metadata/Slic3r_PE.config`) contains `; key = value` config lines but no slice results; treat it as config-only, same as the unsliced-project case above.

3. **ASCII G-code path.**
   - Read the **first 512 KB** of the file. Identify the slicer from the first 1-2 lines:
     - Line begins `; BambuStudio` → `slicer: 'BambuStudio'`.
     - Line begins `; generated by OrcaSlicer` → `slicer: 'OrcaSlicer'`.
     - Line begins `; generated by PrusaSlicer` → `slicer: 'PrusaSlicer'`.
     - None of the above → third-party slicer (e.g. Cura). Out of scope: null-fill everything, `format: 'gcode'`, `slicer: null`, add a warning.
   - Parse `HEADER_BLOCK_START` ... `HEADER_BLOCK_END` if present in the head chunk.
   - Parse `CONFIG_BLOCK_START` ... `CONFIG_BLOCK_END` if present in the head chunk (present for Bambu Studio always, and for OrcaSlicer only when the print target is a Bambu printer; see section 4).
   - **If no config block was found in the head chunk** (OrcaSlicer targeting a non-Bambu printer, or any PrusaSlicer file), read the **last 512 KB** of the file and parse the trailing stats lines plus the EOF config block there (section 4 gives the exact per-slicer block markers).
   - A file smaller than 1 MB total may have its head and tail chunks overlap; that is fine, the parser applies the same line-matching regardless of overlap.

## 4. Per-Slicer Extraction Tables

All keys below are matched by trimming a leading `; ` and splitting on the first `=` (or `:` for header-block lines that do not use `=`, noted per row). Exact casing and spacing shown is verbatim from the dossier; do not normalize key names before matching, only after extracting the value (section 5).

### 4.1 Bambu Studio (`.gcode`, BBL-target printer, the normal case)

Layout: `HEADER_BLOCK_START` at byte 0 (~330 B) → `CONFIG_BLOCK_START` (~30-40 KB, one `; key = value` per line) → `EXECUTABLE_BLOCK_START` (the actual G-code) → file ends at `EXECUTABLE_BLOCK_END`. All of the above is in the first 512 KB.

| Canonical field | Source line / key | Example |
|---|---|---|
| `slicer`, `slicer_version` | First header line | `; BambuStudio 01.10.01.50` |
| `estimated_time_s` | `; model printing time: <dhms>; total estimated time: <dhms>` (use the second, "total estimated time") | `; model printing time: 26s; total estimated time: 6m 9s` |
| `total_layers` | `; total layer number: <int>` | `; total layer number: 1` |
| `filament_used_mm` | `; total filament length [mm] : <float>` (note the space before the colon) | `; total filament length [mm] : 20.12` |
| `filament_used_g` | `; total filament weight [g] : <float>` | `; total filament weight [g] : 0.06` |
| `printer_model` | CONFIG_BLOCK `printer_model` | `; printer_model = Bambu Lab A1 mini` |
| `nozzle_diameters` | CONFIG_BLOCK `nozzle_diameter` (comma-joined per extruder) | `; nozzle_diameter = 0.4` (dual nozzle: `0.4,0.4`) |
| `filament_types` | CONFIG_BLOCK `filament_type` (semicolon-joined per filament) | `; filament_type = PLA` (multi: `PLA;PETG`) |
| `filament_colors` | CONFIG_BLOCK `filament_colour` (semicolon-joined per filament) | `; filament_colour = #ECA514FF` |
| `layer_height_mm` | CONFIG_BLOCK `layer_height` | `; layer_height = 0.2` |

Other CONFIG_BLOCK keys seen but not currently extracted (kept here for reference, do not implement in stage 2 unless the field list above changes): `printer_settings_id`, `printer_variant`, `filament_settings_id` (quoted, e.g. `"Bambu PLA Basic @BBL A1M"`), `print_settings_id`, `curr_bed_type`, `nozzle_type`.

There is no `model printer=` key; do not implement or test for it. The real keys are `printer_model` (CONFIG_BLOCK) and the `model printing time:` line (HEADER_BLOCK); a prior draft of this research incorrectly assumed a combined key and that assumption is explicitly discarded here.

Non-BBL print target (Bambu Studio slicing for a non-Bambu printer) replaces the header time line with `; estimated printing time (normal mode) = 1m 45s`; use that line for `estimated_time_s` when the `model printing time:` line is absent.

### 4.2 OrcaSlicer, BBL target (Bambu printer)

Identical structure to 4.1: `HEADER_BLOCK` + `CONFIG_BLOCK` at the top of the file, same keys. Generator line differs:

`; generated by OrcaSlicer 2.3.1 on 2025-12-25 at 01:38:38`

Additional trailing lines appear **after** `EXECUTABLE_BLOCK_END` at EOF (read via the last-512-KB pass, used as a supplement, not the primary source, since the head chunk already has the config block):

| Canonical field | Source line | Example |
|---|---|---|
| `filament_used_mm` | `; filament used [mm] = <float>` | `; filament used [mm] = 24.88` |
| `filament_used_g` | `; filament used [g] = <float>` (only present when the filament profile's density is greater than 0) | `; filament used [g] = ...` |
| (unused) | `; filament used [cm3] = <float>` | Not extracted; see caveat in section 8 about a known Bambu Studio 1.10 unit bug on this same field name. Prefer `[g]` / `[mm]`. |

### 4.3 OrcaSlicer, non-BBL target (Klipper, Marlin, etc.)

The head-chunk `HEADER_BLOCK` here has **only** the generator line and the total-layer-number line; there is no CONFIG_BLOCK at the top (a thumbnail occupies that space instead). Everything else is at EOF, in the last 512 KB, in this order: trailing stats lines, then `CONFIG_BLOCK_START` ... `CONFIG_BLOCK_END` as the final 12-13 KB of the file.

| Canonical field | Source line / key | Example |
|---|---|---|
| `slicer`, `slicer_version` | Head-chunk generator line | `; generated by OrcaSlicer 2.3.1 on ...` |
| `total_layers` | Head-chunk `; total layer number: <int>` | Same key as 4.1 |
| `estimated_time_s` | EOF `; estimated printing time (normal mode) = <dhms>` | `; estimated printing time (normal mode) = 8m 0s` |
| `filament_used_g` | EOF `; total filament used [g] = <float>` | |
| `total_layers` (cross-check) | EOF `; total layers count = <int>` | Prefer the head-chunk value if both are present; they should agree. |
| `printer_model`, `nozzle_diameters`, `filament_types`, `filament_colors`, `layer_height_mm` | EOF CONFIG_BLOCK, same keys as 4.1 | |

### 4.4 PrusaSlicer

Generator line at byte 0: `; generated by PrusaSlicer 2.9.0 on 2025-02-10 at 18:03:14 UTC`. There is no HEADER_BLOCK/CONFIG_BLOCK pair; everything else is at EOF (last ~13 KB, read the last 512 KB), bounded by `; prusaslicer_config = begin` ... `; prusaslicer_config = end` (the literal last line of the file).

| Canonical field | Source line / key | Example |
|---|---|---|
| `slicer`, `slicer_version` | Byte-0 generator line | `; generated by PrusaSlicer 2.9.0 on ...` |
| `filament_used_mm`, `filament_used_g` | `; filament used [mm] = <float> / [cm3] / [g] / cost` (one combined line; take `[mm]` and `[g]`) | `; filament used [mm] = 496.91 / ...` |
| `filament_used_g` (cross-check) | `; total filament used [g] = <float>` | `; total filament used [g] = 1.49` |
| `estimated_time_s` | `; estimated printing time (normal mode) = <dhms>` | `; estimated printing time (normal mode) = 13m 22s` |
| `layer_height_mm` | Config block `; layer_height = <float>` | `; layer_height = 0.2` |
| `filament_types` | Config block `; filament_type = <str>` | `; filament_type = PLA` |
| `nozzle_diameters` | Config block `; nozzle_diameter = <float>` | `; nozzle_diameter = 0.4` |
| `printer_model` | Config block `; printer_model = <str>` | `; printer_model = NEPTUNE3PRO` |

`total_layers` has no dedicated key in PrusaSlicer output. Fallback: count occurrences of the `;LAYER_CHANGE` marker in the body; if that pass is not implemented in stage 2, leave `total_layers` null and add a warning, per section 6. MK3-family printers add a second time line labeled `(silent mode)`; ignore it and use the `(normal mode)` line only.

### 4.5 3MF Entry Paths and Keys

| Entry | Format | Key fields |
|---|---|---|
| `Metadata/slice_info.config` | XML, per-plate `<metadata key="...">` | `printer_model_id` (machine code, section 4.6), `nozzle_diameters`, `prediction` (`estimated_time_s`, already whole seconds), `weight` (`filament_used_g`, grams, `%.2f`); `<filament id="1" tray_info_idx="GFL99" type="PLA" color="#FFFFFF" used_m="6.40" used_g="19.10"/>` per filament, one element per filament slot for `filament_types`, `filament_colors`, `filament_used_g`. `used_m` is in **meters**, convert to mm for `filament_used_mm` (section 5). Files from BambuStudio 1.7 and earlier lack `printer_model_id` and `nozzle_diameters` in this entry; fall back to `project_settings.config`. Newer files (2.6/H2D generation) additionally carry `extruder_type`, `nozzle_volume_type`, `first_layer_time`, and per-filament `nozzle_diameter`; none of these are in scope for stage 2 beyond feeding the existing fields. |
| `Metadata/project_settings.config` | JSON, ~60 KB, all scalars are JSON strings, per-filament options are arrays of strings | `printer_model` (e.g. `"Bambu Lab A1"`), `printer_settings_id`, `printer_variant`, `nozzle_diameter` (e.g. `["0.4"]`), `filament_type` (e.g. `["PLA"]`), `filament_colour` (e.g. `["#808080"]`), `filament_ids` (e.g. `["GFA00"]`), `print_settings_id`, `layer_height` (e.g. `"0.16"`), `curr_bed_type`. |
| `Metadata/model_settings.config` | XML | `<metadata key="gcode_file" value="Metadata/plate_1.gcode"/>` per plate, used only for plate enumeration (out of scope beyond identifying the first plate for stage 2). |
| `Metadata/plate_N.gcode` | Full G-code including HEADER/CONFIG blocks | Fallback source, parsed with the section 3.3/4.1-4.3 parser if the config entries above left fields null. |
| `Metadata/plate_N.json` | JSON | `bed_type`, `filament_colors`, `filament_ids`, `nozzle_diameter`; a secondary source, not required if `slice_info.config` was informative. |
| `3D/3dmodel.model` | XML | `<metadata name="Application">BambuStudio-02.00.03.54</metadata>` as an alternate source for `slicer` / `slicer_version` if the plate gcode/config entries did not supply it. |
| `Metadata/Slic3r_PE.config` | `; key = value` lines (PrusaSlicer 3MF only) | Same keys as section 4.4's config block; no slice results (no `prediction`/`weight`/plate info) in this entry. |

Unsliced project / MakerWorld 3MF: `slice_info.config` has only a `<header>`, no `<plate>`; there is no `plate_N.gcode`. `project_settings.config` is still present and still populates the config-only fields. Generic core-spec 3MF (e.g. exported from Fusion 360): no `Metadata/*.config` entries at all; null-fill everything, `format: '3mf'`, `slicer: null`.

### 4.6 Bambu `printer_model_id` Codes (full table, from official Bambu Studio machine profiles)

| Code | Model |
|---|---|
| `BL-P001` | X1 Carbon |
| `BL-P002` | X1 |
| `C13` | X1E |
| `C11` | P1P |
| `C12` | P1S |
| `N1` | A1 mini |
| `N2S` | A1 |
| `N7` | P2S |
| `N9` | A2L |
| `N6` | X2D |
| `O1D` | H2D |
| `O1E` | H2D Pro |
| `O1S` | H2S |
| `O1C2` | H2C |

Use this table only to translate `printer_model_id` for display; `printer_model` (the human-readable string) always comes directly from the slicer's own `printer_model` / `Bambu Lab ...` value and is never derived from this table.

## 5. Normalization Rules

- **List separators.** Float lists (e.g. `nozzle_diameter` in gcode CONFIG_BLOCK) are comma-joined: split on `,`. String lists (e.g. `filament_type`, `filament_colour` in gcode CONFIG_BLOCK) are semicolon-joined: split on `;`. 3MF JSON/XML sources are already arrays; no split needed.
- **Quoted values.** A CONFIG_BLOCK value containing a separator character is wrapped in double quotes (e.g. `filament_settings_id = "Bambu PLA Basic @BBL A1M"`). Strip a leading and trailing `"` before further processing, only when both are present.
- **Color formats.** Accept both `#RRGGBB` and `#RRGGBBAA`. Store the value exactly as written (including the trailing alpha pair if present); do not strip alpha and do not re-case the hex digits.
- **Time parsing (d/h/m/s text).** Format is `[Nd ][Nh ][Nm ][Ns]`, each component optional, space-separated, in descending unit order (e.g. `1h 2m 3s`, `6m 9s`, `26s`). Regex: `/^(?:(\d+)d\s*)?(?:(\d+)h\s*)?(?:(\d+)m\s*)?(?:(\d+)s)?$/`. Convert to total whole seconds. A 3MF `prediction` value is already an integer number of seconds and needs no regex, just a direct parse.
- **Meters vs millimeters.** 3MF `<filament ... used_m="6.40" .../>` is in **meters**. Multiply by 1000 to get the millimeters value stored in `filament_used_mm`. Gcode-sourced `filament_used_mm` values (`[mm]` header/trailing lines) are already in millimeters; do not convert those.
- **Optional fallback for estimated time.** If no textual or `prediction` time value was found anywhere in scope, an optional secondary source is the first `M73 P0 Rn` line after `EXECUTABLE_BLOCK_START` in an ASCII gcode file, where `n` is remaining minutes at print start; this is a fallback only, not required for stage 2's acceptance tests, and should be flagged with a warning if used since it is a coarser (minute-resolution) estimate.

## 6. Null-Fill Matrix

| Case | Expected parser output |
|---|---|
| Unsliced 3MF (project or MakerWorld export) | `format: '3mf'`, config-only fields populated from `project_settings.config`, `estimated_time_s`/`filament_used_g`/`filament_used_mm`/`total_layers` null (no plate info exists to source them from). |
| Old Bambu 3MF, BambuStudio <=1.7 | `format: '3mf'`, `printer_model_id` and `nozzle_diameters` null from `slice_info.config` (key absent in that version); fall back to `project_settings.config` for those two fields instead of leaving them null. |
| Bambu Studio or OrcaSlicer gcode, non-BBL print target | `estimated_time_s` sourced from `estimated printing time (normal mode)` line instead of `model printing time:` (absent in this target). |
| OrcaSlicer gcode, non-BBL target specifically | No CONFIG_BLOCK in the head chunk (thumbnail occupies that space); config fields come from the EOF CONFIG_BLOCK only, per section 4.3. |
| OrcaSlicer, filament density = 0 | No `[g]` or cost trailing line; `filament_used_g` stays an empty array, `filament_used_mm` still populated. |
| PrusaSlicer, any file | No `total_layers` key exists in this slicer's output at all; null unless the `;LAYER_CHANGE` count fallback (section 4.4) is implemented. No HEADER_BLOCK/CONFIG_BLOCK pair either, all fields come from the EOF block described in section 4.4. |
| `.bgcode` (PrusaSlicer binary gcode) | `format: 'bgcode'`, every other field null/empty, one warning noting binary gcode is not parsed. Detected by the `GCDE` magic bytes; do not scan further. |
| Third-party slicer (e.g. Cura, identifiable by `;FLAVOR:` / `;TIME:` style headers) | `format: 'gcode'`, `slicer: null`, every other field null/empty, one warning noting the generator was not recognized. Out of scope for extraction (section 9). |
| Generic core-spec 3MF with no `Metadata/*.config` entries (e.g. plain Fusion 360 export) | `format: '3mf'`, `slicer: null`, everything else null/empty. |
| Any read error (corrupt ZIP, truncated file, permission error, unexpected exception anywhere in the parse) | `format: 'unknown'` unless the format was already confidently detected before the error (in which case keep that `format` value), every other field null/empty, one warning with a short description of what failed. Never throw out of `parseHeader`. |

Config blocks are written unconditionally by current Bambu Studio, OrcaSlicer, and PrusaSlicer for ASCII exports. Their total absence, outside the specific cases in this table, implies a third-party slicer, a binary/ancient/stripped file, or file corruption; treat it the same as the third-party case (null-fill plus a warning), do not attempt to special-case it further.

## 7. Dependency Decision

**Add `yauzl` pinned to exact version `3.4.0`** as a new production dependency, used only by `server/lib/headerParser.js` for the 3MF/ZIP path.

Rationale from the research dossier: Node 22 has no built-in ZIP container API. `yauzl` reads the End Of Central Directory plus central directory records and gives random-access reads to individual entries, so a 200 MB 3MF costs only the size of the entries actually read (`slice_info.config`, `project_settings.config`, and only occasionally a plate gcode entry), not the whole file. It is MIT-licensed, pure JavaScript (no native build step, relevant to the Windows/Node 22-23 production constraint), has one small dependency (`pend`), was maintained as of the dossier's research date, and correctly handles ZIP64, which Bambu's larger 3MF files use. `fflate` and `adm-zip` were considered and rejected: both require loading the whole file into memory to do random access, which is the wrong shape for this use case (files range from 50 KB to hundreds of MB per the dossier). `yauzl`'s API is callback-based; the three calls this module needs (`open`, entry-read, `readEntry`) will be wrapped in promises inside `headerParser.js` rather than pulling in a callback-to-promise dependency for three call sites.

Alternative considered: hand-rolled EOCD (End Of Central Directory) parsing, reading only the last 64 KB plus the central directory, without any third-party dependency. Rejected for stage 2 because it reimplements ZIP64 handling (required for Bambu's larger files) and central-directory record parsing from scratch, which is exactly the kind of "guessed protocol/format" risk this codebase's rules warn against elsewhere; a maintained pure-JS library that already handles ZIP64 correctly is the safer bet for a bulk-tier implementation pass.

**This is a new runtime dependency and is flagged per CLAUDE.md's escalation rules** (native modules doubly so, though `yauzl` is pure JS with no native build step). Joel's sign-off is needed before stage 2 adds it to `package.json`.

## 8. Fixture Plan for Stage 2

Stage 2 needs deterministic, small, committed fixtures under `server/tests/fixtures/gcode/`, built from the verbatim examples quoted in section 4 of this spec:

- One synthetic ASCII gcode fixture per slicer/target combination covering sections 4.1 through 4.4: Bambu Studio BBL-target, Bambu Studio non-BBL-target, OrcaSlicer BBL-target, OrcaSlicer non-BBL-target, PrusaSlicer. Each fixture is small: the real header/config block text from this spec's tables, followed by a few hundred lines of placeholder G-code body (not a real print), followed by the real trailing/EOF block text where applicable. This is enough to exercise the head/tail read logic and every key in the extraction tables without committing megabyte-scale files.
- One synthetic `.bgcode`-style fixture: just the `GCDE` magic bytes followed by arbitrary binary padding, to exercise the bail-out path.
- One synthetic third-party fixture (Cura-style `;FLAVOR:`/`;TIME:` header) to exercise the null-fill/unknown path.
- One minimal 3MF fixture built in-test (not committed as a binary blob): a small ZIP constructed at test-run time containing a minimal `Metadata/slice_info.config`, `Metadata/project_settings.config`, and `Metadata/model_settings.config`, populated with the example values from section 4.5, so the test asserts against values the test itself controls.
- One 3MF fixture variant with `slice_info.config` missing `printer_model_id`/`nozzle_diameters` (the old-Bambu case from section 6) to exercise the `project_settings.config` fallback.

**Real sliced files are still required before hardware rollout.** These synthetic fixtures prove the parser matches the documented format exactly; they cannot prove the documented format is what a current install of Bambu Studio, OrcaSlicer, or PrusaSlicer actually writes today. Per TASKS.md's Task 4 brief, a human must collect 3-5 real sliced files per slicer (at minimum the Bambu ones) and add them to `server/tests/fixtures/gcode/` before this parser's output is trusted against real hardware; stage 2's test suite passing against synthetic fixtures only demonstrates contract compliance with this spec, not real-world correctness.

## 9. Out of Scope

- **Auto-assignment of jobs from parsed data.** This PR is detection and display only. Using parsed printer model, nozzle, or material to auto-match a part's g-code or to auto-select a printer is a follow-up brief once trust in the parser is established (see TASKS.md).
- **Cura.** Cura-generated files are detected only enough to null-fill gracefully (section 6); no Cura-specific extraction table exists and none should be added in stage 2.
- **`.bgcode` block parsing.** The binary G-code format used by newer PrusaSlicer builds is detected by magic bytes only and always null-filled. Parsing its internal block structure is not in scope for this spec.
