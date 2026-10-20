// Noise_XX_25519_AESGCM_SHA256 initiator, matching muse.ai's web client.
import crypto from "node:crypto";

const PROTOCOL_NAME = "Noise_XX_25519_AESGCM_SHA256";
const DH_LEN = 32;
const TAG_LEN = 16;
const EMPTY = Buffer.alloc(0);

const sha256 = (data) => crypto.createHash("sha256").update(data).digest();
const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();

function hkdf(chainingKey, ikm, n) {
  const temp = hmac(chainingKey, ikm);
  const out1 = hmac(temp, Buffer.from([1]));
  const out2 = hmac(temp, Buffer.concat([out1, Buffer.from([2])]));
  if (n === 2) return [out1, out2];
  return [out1, out2, hmac(temp, Buffer.concat([out2, Buffer.from([3])]))];
}

function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519");
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  return { publicKey: pub, privateKey };
}

function dh(privateKey, publicKeyBytes) {
  const publicKey = crypto.createPublicKey({
    key: { kty: "OKP", crv: "X25519", x: Buffer.from(publicKeyBytes).toString("base64url") },
    format: "jwk",
  });
  const shared = crypto.diffieHellman({ privateKey, publicKey });
  if (shared.every((b) => b === 0)) throw new Error("x25519: DH produced all-zeros output");
  return shared;
}

export class CipherState {
  #key = null;
  #nonce = 0n;

  constructor(key = null) {
    this.#key = key;
  }

  hasKey() {
    return this.#key != null;
  }

  #iv() {
    const iv = Buffer.alloc(12);
    iv.writeBigUInt64BE(this.#nonce++, 4);
    return iv;
  }

  encrypt(ad, plaintext) {
    if (!this.#key) return Buffer.from(plaintext);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.#key, this.#iv());
    cipher.setAAD(ad);
    return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  }

  decrypt(ad, ciphertext) {
    if (!this.#key) return Buffer.from(ciphertext);
    const body = ciphertext.subarray(0, ciphertext.length - TAG_LEN);
    const tag = ciphertext.subarray(ciphertext.length - TAG_LEN);
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.#key, this.#iv());
    decipher.setAAD(ad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  }
}

class SymmetricState {
  constructor() {
    const name = Buffer.alloc(32);
    name.write(PROTOCOL_NAME);
    this.h = name;
    this.ck = Buffer.from(name);
    this.cipher = new CipherState();
    this.mixHash(EMPTY);
  }

  mixHash(data) {
    this.h = sha256(Buffer.concat([this.h, data]));
  }

  mixKey(ikm) {
    const [ck, k] = hkdf(this.ck, ikm, 2);
    this.ck = ck;
    this.cipher = new CipherState(k);
  }

  encryptAndHash(plaintext) {
    const ct = this.cipher.encrypt(this.h, plaintext);
    this.mixHash(ct);
    return ct;
  }

  decryptAndHash(ciphertext) {
    const pt = this.cipher.decrypt(this.h, ciphertext);
    this.mixHash(ciphertext);
    return pt;
  }

  split() {
    const [k1, k2] = hkdf(this.ck, EMPTY, 2);
    return [new CipherState(k1), new CipherState(k2)];
  }
}

export class NoiseXXInitiator {
  #ss = new SymmetricState();
  #e = null;
  #re = null;

  writeMessage1(payload = EMPTY) {
    this.#e = generateKeyPair();
    this.#ss.mixHash(this.#e.publicKey);
    return Buffer.concat([this.#e.publicKey, this.#ss.encryptAndHash(payload)]);
  }

  /** Returns the server's handshake payload (attestation / RV challenge). */
  readMessage2(msg) {
    if (msg.length < DH_LEN * 2 + TAG_LEN * 2) throw new Error("Noise: message 2 too short");
    let offset = 0;
    this.#re = msg.subarray(offset, (offset += DH_LEN));
    this.#ss.mixHash(this.#re);
    this.#ss.mixKey(dh(this.#e.privateKey, this.#re));
    const rs = this.#ss.decryptAndHash(msg.subarray(offset, (offset += DH_LEN + TAG_LEN)));
    this.#ss.mixKey(dh(this.#e.privateKey, rs));
    return this.#ss.decryptAndHash(msg.subarray(offset));
  }

  writeMessage3(payload = EMPTY) {
    const s = generateKeyPair();
    const encS = this.#ss.encryptAndHash(s.publicKey);
    this.#ss.mixKey(dh(s.privateKey, this.#re));
    return Buffer.concat([encS, this.#ss.encryptAndHash(payload)]);
  }

  /** [send, recv] cipher states. */
  split() {
    return this.#ss.split();
  }
}
