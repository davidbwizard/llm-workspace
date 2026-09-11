import fs from 'node:fs';
import { crc32, inflateSync } from 'node:zlib';

// Format references are in README.md. No image editor or external process needed.
export function readAseprite(filename) {
  const data = fs.readFileSync(filename);
  const fail = message => { throw new Error(`Invalid Aseprite (${filename}): ${message}`); };
  if (data.length < 128 || data.readUInt16LE(4) !== 0xa5e0) fail('header');
  if (data.readUInt32LE(0) !== data.length) fail('file length');
  const timelineFrames = data.readUInt16LE(6);
  const canvasSize = [data.readUInt16LE(8), data.readUInt16LE(10)];
  if (!timelineFrames || canvasSize.some(value => !value)) fail('empty canvas or timeline');
  const tags = [];
  let position = 128;
  for (let frame = 0; frame < timelineFrames; frame++) {
    if (position + 16 > data.length) fail('truncated frame');
    const end = position + data.readUInt32LE(position);
    if (end <= position + 15 || end > data.length || data.readUInt16LE(position + 4) !== 0xf1fa) fail('frame boundary');
    const chunks = data.readUInt32LE(position + 12) || data.readUInt16LE(position + 6);
    let chunk = position + 16;
    for (let index = 0; index < chunks; index++) {
      if (chunk + 6 > end) fail('truncated chunk');
      const chunkEnd = chunk + data.readUInt32LE(chunk);
      if (chunkEnd < chunk + 6 || chunkEnd > end) fail('chunk boundary');
      if (data.readUInt16LE(chunk + 4) === 0x2018) {
        if (chunk + 16 > chunkEnd) fail('tag header');
        const count = data.readUInt16LE(chunk + 6);
        let tag = chunk + 16;
        for (let index = 0; index < count; index++) {
          if (tag + 19 > chunkEnd) fail('truncated tag');
          const from = data.readUInt16LE(tag);
          const to = data.readUInt16LE(tag + 2);
          const length = data.readUInt16LE(tag + 17);
          if (from > to || to >= timelineFrames || tag + 19 + length > chunkEnd) fail('tag range');
          tags.push({ name: data.toString('utf8', tag + 19, tag + 19 + length), from, to, frames: to - from + 1 });
          tag += 19 + length;
        }
      }
      chunk = chunkEnd;
    }
    if (chunk !== end) fail('chunk count');
    position = end;
  }
  if (position !== data.length) fail('trailing frame data');
  return { canvasSize, timelineFrames, tags };
}

function paeth(left, up, upperLeft) {
  const p = left + up - upperLeft;
  const a = Math.abs(p - left), b = Math.abs(p - up), c = Math.abs(p - upperLeft);
  return a <= b && a <= c ? left : b <= c ? up : upperLeft;
}

// All PNGs in this pack are non-interlaced, 8-bit RGBA. Other valid PNG formats
// retain their dimensions but explicitly report that pixel inspection is unsupported.
export function inspectPng(data, filename = 'buffer') {
  const fail = message => { throw new Error(`Invalid PNG (${filename}): ${message}`); };
  if (data.length < 33 || !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) fail('header');
  const compressed = [];
  let size, format, ended = false, dataEnded = false, animated = false;
  for (let position = 8; position < data.length;) {
    if (position + 12 > data.length) fail('truncated chunk');
    const length = data.readUInt32BE(position), end = position + 12 + length;
    if (end > data.length) fail('chunk length');
    const type = data.toString('ascii', position + 4, position + 8);
    if (crc32(data.subarray(position + 4, end - 4)) !== data.readUInt32BE(end - 4)) fail(`checksum for ${type}`);
    if (position === 8 && type !== 'IHDR') fail('missing IHDR');
    if (type === 'IHDR') {
      if (size || length !== 13) fail('IHDR');
      size = [data.readUInt32BE(position + 8), data.readUInt32BE(position + 12)];
      format = [...data.subarray(position + 16, position + 21)];
      const [depth, color, compression, filter, interlace] = format;
      const allowed = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (size.some(value => !value || value > 0x7fffffff) || !allowed[color]?.includes(depth)
        || compression !== 0 || filter !== 0 || interlace > 1) fail('unsupported header values');
    } else if (type === 'IDAT') {
      if (dataEnded) fail('nonconsecutive IDAT');
      compressed.push(data.subarray(position + 8, end - 4));
    } else {
      if (compressed.length) dataEnded = true;
      if (type === 'acTL') animated = true;
      if (type === 'IEND') {
        if (length !== 0 || end !== data.length) fail('IEND');
        ended = true;
      } else if (!['PLTE'].includes(type) && type[0] === type[0].toUpperCase()) fail(`unknown critical chunk ${type}`);
    }
    position = end;
  }
  if (!ended || !compressed.length) fail('missing image data or IEND');
  const result = { width: size[0], height: size[1], imageSize: size, empty: null, pixelInspection: 'unsupported' };
  if (format[0] !== 8 || format[1] !== 6 || format[4] !== 0 || animated) return result;
  const stride = size[0] * 4;
  const expected = (stride + 1) * size[1];
  if (expected > 128 * 1024 * 1024) throw new Error(`PNG pixel inspection exceeds 128 MiB limit: ${filename}`);
  const raw = inflateSync(Buffer.concat(compressed), { maxOutputLength: expected });
  if (raw.length !== expected) fail('decompressed length');
  let previous = Buffer.alloc(stride), row = Buffer.alloc(stride), empty = true;
  for (let y = 0; y < size[1]; y++) {
    const offset = y * (stride + 1), filter = raw[offset];
    if (filter > 4) fail('row filter');
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? row[x - 4] : 0, up = previous[x], upperLeft = x >= 4 ? previous[x - 4] : 0;
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up
        : filter === 3 ? Math.floor((left + up) / 2) : paeth(left, up, upperLeft);
      row[x] = (raw[offset + 1 + x] + predictor) & 255;
      if (x % 4 === 3 && row[x] !== 0) empty = false;
    }
    [row, previous] = [previous, row];
  }
  return { ...result, empty, pixelInspection: 'complete' };
}
