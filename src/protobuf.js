// Minimal protobuf wire codec for the few hatch.noise messages we need.

const WT_VARINT = 0;
const WT_LEN = 2;

export class Writer {
  #parts = [];

  #varint(value) {
    let v = BigInt.asUintN(64, BigInt(value));
    const out = [];
    while (v > 0x7fn) {
      out.push(Number(v & 0x7fn) | 0x80);
      v >>= 7n;
    }
    out.push(Number(v));
    this.#parts.push(Buffer.from(out));
  }

  #tag(field, wireType) {
    this.#varint((field << 3) | wireType);
  }

  uint(field, value) {
    this.#tag(field, WT_VARINT);
    this.#varint(value);
    return this;
  }

  bool(field, value) {
    return this.uint(field, value ? 1 : 0);
  }

  bytes(field, value) {
    const buf = Buffer.from(value);
    this.#tag(field, WT_LEN);
    this.#varint(buf.length);
    this.#parts.push(buf);
    return this;
  }

  string(field, value) {
    return this.bytes(field, Buffer.from(value, "utf8"));
  }

  finish() {
    return Buffer.concat(this.#parts);
  }
}

/** Decode a message into { [field]: value[] }; varints are BigInt, length-delimited are Buffer. */
export function decode(buf) {
  buf = Buffer.from(buf.buffer ?? buf, buf.byteOffset ?? 0, buf.byteLength ?? buf.length);
  const fields = {};
  let pos = 0;
  const varint = () => {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (pos >= buf.length) throw new Error("protobuf: truncated varint");
      const b = buf[pos++];
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result;
      shift += 7n;
    }
  };
  while (pos < buf.length) {
    const tag = Number(varint());
    const field = tag >>> 3;
    const wireType = tag & 7;
    let value;
    if (wireType === WT_VARINT) value = varint();
    else if (wireType === WT_LEN) {
      const len = Number(varint());
      value = buf.subarray(pos, pos + len);
      pos += len;
    } else if (wireType === 1) {
      value = buf.subarray(pos, pos + 8);
      pos += 8;
    } else if (wireType === 5) {
      value = buf.subarray(pos, pos + 4);
      pos += 4;
    } else throw new Error(`protobuf: unsupported wire type ${wireType}`);
    (fields[field] ??= []).push(value);
  }
  return fields;
}

export const first = (fields, n) => fields[n]?.[0];
