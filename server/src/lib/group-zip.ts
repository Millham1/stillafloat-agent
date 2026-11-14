// A plain ZIP file of a few PDFs, written by hand so the server needs no new package (Mark 2026-11-14: "there should be an
// option to download all at once"). The files are stored as they are, not compressed: a PDF is already compressed, and a sealed
// copy must reach the signer byte for byte.

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** File names as a ZIP on any computer will show them: plain letters, digits, spaces, dots and dashes. */
export function zipName(name: string): string {
  return name.normalize("NFKD").replace(/[^\w .-]/g, "").replace(/\s+/g, " ").trim().slice(0, 100) || "document";
}

export function zipStored(files: Array<{ name: string; bytes: Uint8Array }>, at: Date = new Date()): Buffer {
  const time = ((at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | (at.getUTCSeconds() >> 1)) & 0xffff;
  const date = (((Math.max(1980, at.getUTCFullYear()) - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate()) & 0xffff;
  const parts: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8"), data = Buffer.from(f.bytes), crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(20, 6); head.writeUInt16LE(0x0800, 8); head.writeUInt16LE(0, 10);
    head.writeUInt16LE(time, 12); head.writeUInt16LE(date, 14); head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(data.length, 20); head.writeUInt32LE(data.length, 24); head.writeUInt16LE(name.length, 28);
    head.writeUInt32LE(offset, 42);
    parts.push(local, name, data);
    central.push(head, name);
    offset += 30 + name.length + data.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}
