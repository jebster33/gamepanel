'use strict';

/**
 * Reading files inside a server's folder, which a game, a mod or a player
 * can fill with surprises: a FIFO or device file where a normal file should
 * be (opening it blocks the whole panel), a symlink to somewhere else, or a
 * huge file. These open without following a link or waiting, check that it is
 * a regular file, and stop at a size limit.
 */

const fs = require('fs');

const FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0) | (fs.constants.O_NOFOLLOW || 0);

/**
 * Open without following a link. Windows has no O_NOFOLLOW, so there the link
 * is looked for first (a narrow window is left between the look and the open).
 */
function openFlat(file) {
  if (!fs.constants.O_NOFOLLOW && fs.lstatSync(file).isSymbolicLink()) throw Object.assign(new Error('not a regular file (it is a link)'), { code: 'ELOOP' });
  return fs.openSync(file, FLAGS);
}

/** A file's contents as a Buffer, or throws. */
function readRegular(file, max = 4 * 1024 * 1024) {
  const fd = openFlat(file);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw Object.assign(new Error('not a regular file'), { code: 'ENOTREG' });
    if (st.size > max) throw Object.assign(new Error(`file is larger than ${max} bytes`), { code: 'EFBIG' });
    const buf = Buffer.alloc(st.size);
    let got = 0;
    while (got < st.size) {
      const n = fs.readSync(fd, buf, got, st.size - got, got);
      if (!n) break;
      got += n;
    }
    return buf.subarray(0, got);
  } finally {
    fs.closeSync(fd);
  }
}

const readText = (file, max) => readRegular(file, max).toString('utf8');

/** The last `bytes` of a regular file as text ('' when it cannot be read). */
function tailText(file, bytes = 2 * 1024 * 1024) {
  let fd;
  try {
    fd = openFlat(file);
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return '';
    const len = Math.min(st.size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** An open file descriptor for a regular file (for readers that seek), or throws. */
function openRegular(file) {
  const fd = openFlat(file);
  if (!fs.fstatSync(fd).isFile()) {
    fs.closeSync(fd);
    throw Object.assign(new Error('not a regular file'), { code: 'ENOTREG' });
  }
  return fd;
}

module.exports = { readRegular, readText, tailText, openRegular };
