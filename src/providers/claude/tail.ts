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
    // every subsequent offset, poisoning both the identity key (source_file,
    // source_offset, content_hash, sub_index) and newOffset, so the next
    // incremental read resumes in the wrong place.
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

    // D1: newOffset is computed from Buffer.byteLength of DECODED text, not
    // from bytes actually read. Chunk-split multi-byte characters are
    // handled correctly above via StringDecoder, but genuinely malformed
    // UTF-8 (not merely split -- an invalid byte the source file actually
    // contains) decodes to one or more U+FFFD replacement characters, whose
    // re-encoded length can differ from the bytes they replaced (one invalid
    // byte becomes a 3-byte U+FFFD). That silently drifts newOffset past
    // where the file's bytes actually end -- the next call sees a
    // "truncated" file (size < fromOffset), latches `restarted`, and
    // reparses the whole file every single pass, forever, with no visible
    // error. Fail loudly instead: newOffset can never legitimately exceed
    // the bytes read this call.
    if (carryStart > size) {
      throw new Error(
        `readTail: computed offset ${carryStart} exceeds file size ${size} read from ${path} -- ` +
        'likely malformed (not merely chunk-split) UTF-8 drifting the byte offset',
      );
    }

    return { lines, newOffset: carryStart, restarted, inode, size };
  } finally {
    closeSync(fd);
  }
}
