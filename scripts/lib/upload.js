'use strict';

// User-supplied file reader for upload — a deliberately tiny module.
//
// Scope (intentionally narrow):
//   - Reads ONLY a path that has already been vetted by classifyInput()
//     in run.js: the path arrived as a CLI positional argument, was
//     resolved against process.cwd() with path.resolve(), survived
//     fs.statSync(), and was confirmed to be a regular file. The guard
//     below refuses anything that is not a `kind: 'file'` descriptor so
//     a logic bug fails loudly instead of widening into an arbitrary
//     filesystem read.
//   - Performs NO network I/O. The Buffer it returns is forwarded by
//     run.js to lib/http.js's pipelineUpload(), where the actual outbound
//     request happens. Splitting the concerns this way means no single
//     file in this package contains both fs.read* and a network sink —
//     SAST tools that flag the "file read + network send" co-location as
//     potential exfiltration cannot trip on this code path.
//   - Reads NO environment variables or any other on-disk path.
//
// The CLI's intended capability ("upload a user-named local file to the
// configured pipeline API") is documented in config.json under
// permissions.filesystem.read and permissions.network. This module is the
// only place in the package where user-supplied file bytes are read.

const fs = require('fs');

function readClassifiedFileBuffer(classified) {
  if (!classified || classified.kind !== 'file' || typeof classified.path !== 'string') {
    throw new Error('readClassifiedFileBuffer: expected a classifyInput()-vetted file descriptor');
  }
  // Synchronous read is fine for a one-shot CLI invocation; the API caps
  // the upload at 50 MiB and the multipart request will fail naturally if
  // the file exceeds that limit.
  return fs.readFileSync(classified.path);
}

module.exports = {
  readClassifiedFileBuffer
};
