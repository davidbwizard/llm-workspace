import { openSync, readSync, fstatSync, closeSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

export interface TailLine { text: string; offset: number }

export interface TailResult {
  lines: TailLine[];
  newOffset: number;   // byte offset after the last COMPLETE line
  restarted: boolean;  // true when truncation or replacement forced a re-read
  inode: number;
  size: number;
}

const DEFAULT_CHUNK = 1 << 20;

/** Incremental tail read. Spec §6.6.
 *  Two rules that matter:
 *   - a shrink or inode change means truncation/replacement, so re-read from 0
 *     rather than appending garbage;
 *   - a trailing partial line is NORMAL (the file is being written as we read),
 *     so buffer it and leave newOffset before it. Never count it as corrupt. */
export function readTail(
  path: string,
  fromOffset: number,
  knownInode: number | null,
  chunkSize = DEFAULT_CHUNK,   // injectable so tests can force multi-chunk reads
): TailResult {
  const fd = openSync(path, 'r');
  try {
    const st = fstatSync(fd);
    const inode = Number(st.ino);
    const size = st.size;

    let start = fromOffset;
    let restarted = false;
    if (size < fromOffset || (knownInode !== null && knownInode !== inode)) {
      start = 0;
      restarted = true;
    }

    const lines: TailLine[] = [];
    let cursor = start;
    let carry = '';
    let carryStart = start;

    // A multi-byte character straddling a chunk boundary must NOT be decoded
    // as two halves: `buf.toString('utf8')` would yield U+FFFD replacement
    // chars, corrupting the line AND inflating its byte length — which shifts
    // every subsequent offset, poisoning both the identity triple and
    // newOffset, so the next incremental read resumes in the wrong place.
    // StringDecoder holds the partial sequence until the next chunk supplies
    // the rest. Verified: splitting a 4-byte emoji naively turns 19 bytes into
    // 27. 105 transcripts on the dev machine already exceed one chunk.
    const decoder = new StringDecoder('utf8');

    while (cursor < size) {
      const want = Math.min(chunkSize, size - cursor);
      const buf = Buffer.allocUnsafe(want);
      const got = readSync(fd, buf, 0, want, cursor);
      if (got <= 0) break;

      const text = carry + decoder.write(buf.subarray(0, got));
      let searchFrom = 0;
      let nl: number;
      while ((nl = text.indexOf('\n', searchFrom)) !== -1) {
        const raw = text.slice(searchFrom, nl);
        const byteOffset = carryStart + Buffer.byteLength(text.slice(0, searchFrom), 'utf8');
        if (raw.trim().length > 0) lines.push({ text: raw, offset: byteOffset });
        searchFrom = nl + 1;
      }
      carry = text.slice(searchFrom);
      carryStart += Buffer.byteLength(text.slice(0, searchFrom), 'utf8');
      cursor += got;
    }

    return { lines, newOffset: carryStart, restarted, inode, size };
  } finally {
    closeSync(fd);
  }
}
