// Bridge-line grammar, kept apart from main.js so it can be unit-tested in plain Node.
// Custom bridge lines are pasted by the user and written into tor's torrc verbatim,
// so this is the only gate between that text and tor's configuration language.
const BRIDGE_LINE = /^((?:obfs4|obfs2|obfs3|scramblesuit|fte|meek|meek_lite|meek_azure|snowflake|webtunnel|flashproxy|dtpt)\s+\S+|https?:\/\/\S+|\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}\s+\S+)(?:\s+\S.*)?$/i
const MAX_BRIDGE_LINE = 512 // tor rejects absurdly long lines; paste errors look like this

// \s matches \n, so the grammar alone lets "obfs4\nRunAsDaemon 1" through as one line.
// These go into torrc verbatim, so a line must be a line.
const isBridgeLine = line =>
  line.length > 0 && line.length <= MAX_BRIDGE_LINE && !/[\r\n]/.test(line) && BRIDGE_LINE.test(line)

// What the user pasted becomes the list of lines: trim, drop the blank ones, and accept the
// "Bridge " prefix that bridge distribution pages put in front of every line.
function parseBridgePaste(text) {
  return String(text || '').split('\n').map(l => l.trim().replace(/^Bridge\s+/i, '')).filter(Boolean)
}

module.exports = { BRIDGE_LINE, MAX_BRIDGE_LINE, isBridgeLine, parseBridgePaste }
