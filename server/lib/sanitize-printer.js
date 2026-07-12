// Shared printer-row redactor. Every API response that returns a printer row must pass
// it through here first so printer credentials never reach any client, for any role.
//
// What gets redacted:
//   api_key       The Bambu LAN access code (MQTT + FTP password) / PrusaLink API key /
//                 OctoPrint API key. Removed entirely and replaced with api_key_set
//                 (1 when a non-empty key is stored, else 0) so the UI can show
//                 "set / not set" without ever seeing the value.
//   serial_number The other half of the Bambu LAN credential pair (it is the MQTT topic
//                 key). Masked to its last 4 characters as '****' + tail so an operator
//                 can still tell two printers apart. null stays null and '' stays ''.
//
// Drivers keep reading the real api_key / serial_number straight from the DB internally
// (see server/drivers/*), so nothing in server-to-printer communication changes: this
// only affects what is serialized back to a client.
//
// The full row is preserved otherwise, including computed columns the routes attach
// (last_parts_per_plate, has_active_job, ...), so callers can sanitize the exact row they
// were about to send.

function maskSerial(serial) {
  if (serial == null || serial === '') return serial; // null stays null, '' stays ''
  const s = String(serial);
  return '****' + s.slice(-4);
}

// Redact a single printer row. Returns a new object; the input row is not mutated.
// Non-object input (null/undefined) is returned unchanged so callers do not have to guard.
function sanitizePrinter(row) {
  if (!row || typeof row !== 'object') return row;
  const { api_key, ...rest } = row;
  rest.api_key_set = api_key ? 1 : 0;
  rest.serial_number = maskSerial(rest.serial_number);
  return rest;
}

// Redact an array of printer rows.
function sanitizePrinters(rows) {
  if (!Array.isArray(rows)) return rows;
  return rows.map(sanitizePrinter);
}

module.exports = { sanitizePrinter, sanitizePrinters, maskSerial };
