#!/bin/sh
# Acquisition of the Tor binaries (including lyrebird, the bridge program) moved to
# Node so it runs on Windows too: see scripts/fetch-tor.js and npm run tor:fetch.
# This shim stays so old commands and CI steps keep working.
exec node "$(dirname "$0")/fetch-tor.js" "$@"
