import * as bls12381 from '@transmute/did-key-bls12381'
import bls, { init } from '@chainsafe/bls/switchable'
// import bls from "@chainsafe/bls";
import type { PublicKey, SecretKey, Signature } from '@chainsafe/bls/types'
import BitSet from 'bitset'
import { CID } from 'kubo-rpc-client'
import { encodePayload } from 'dag-jose-utils'
import { encodeBase64Url, decodeBase64, encodeBase64 } from 'dids/lib/utils'
import * as u8a from 'uint8arrays'
import { parse } from 'did-resolver'
import { SignaturePacked, SignatureType } from '../../types'


/**
 * Light implementation of BLS DIDs
 * Not standard compliant
 * G1 BLS curves
 */
export class BlsDID {
  private privKey: SecretKey
  pubKey: PublicKey

  constructor({ privKey, pubKey }: { privKey?: SecretKey; pubKey: PublicKey }) {
    this.privKey = privKey
    this.pubKey = pubKey
  }

  get id() {
    
    const publicKey = this.pubKey.toBytes()
    const bytes = new Uint8Array(publicKey.length + 2)
    bytes[0] = 0xea // ed25519 multicodec
    // The multicodec is encoded as a varint so we need to add this.
    // See js-multicodec for a general implementation
    bytes[1] = 0x01
    bytes.set(publicKey, 2)
    return `did:key:z${u8a.toString(bytes, 'base58btc')}`
  }

  async verify({ msg, sig }) {
    let signature: Signature
    if (typeof sig === 'string') {
      signature = bls.Signature.fromBytes(decodeBase64(sig))
    } else {
      signature = bls.Signature.fromBytes(sig)
    }
    if (typeof sig === 'string') {
      msg = decodeBase64(sig)
    } else {
      msg = msg
    }
    return signature.verify(this.pubKey, msg)
  }

  async sign(msg) {
    if (!this.privKey) {
      throw new Error('No private key!')
    }
    const encodedPayload = await encodePayload(msg)

    return encodeBase64(this.privKey.sign(encodedPayload.cid.bytes).toBytes())
  }
  
  async signPacked(msg) {
    if (!this.privKey) {
      throw new Error('No private key!')
    }
    const encodedPayload = await encodePayload(msg)

    const signature = encodeBase64(this.privKey.sign(encodedPayload.cid.bytes).toBytes());
  
    return {
      link: encodedPayload.cid,
      signature
    }
  }
  
  async signObject(msg): Promise<SignaturePacked> {
    if (!this.privKey) {
      throw new Error('No private key!')
    }
    const encodedPayload = await encodePayload(msg)
  
    const signature = encodeBase64(this.privKey.sign(encodedPayload.cid.bytes).toBytes());
  
    return {
      ...msg,
      signatures: [
        {
          t: SignatureType.BLS,
          s: signature
        }
      ]
    }
  }

  static fromSeed(seed: Uint8Array) {
    return new BlsDID({
      privKey: bls.SecretKey.fromKeygen(seed),
      pubKey: bls.SecretKey.fromKeygen(seed).toPublicKey(),
    })
  }

  static fromString(did: string) {
    const parseDid = parse(did)
    const pubKey = u8a.fromString(parseDid.id.slice(1), 'base58btc').slice(2)

    return new BlsDID({
      pubKey: bls.PublicKey.fromBytes(pubKey),
    })
  }
}

/**
 * Aggregated bls signatures with mapping
 */
export class BlsCircuit {
  did: BlsDID
  sig: Uint8Array
  msg: Uint8Array
  aggPubKeys: Map<string, boolean>
  // bitSet: BitSet
  constructor(msg) {
    this.msg = msg
    let date = new Date()
    this.aggPubKeys = new Map()
  }

  add(data: { did: string; sig: string }) {
    return this.addMany([data])
  }

  addMany(data: Array<{ did: string; sig: string }>): { errors: string[] } {
    let publicKeys = []
    let sigs = []
    let errors = []
    for (let e of data) {
      const did = BlsDID.fromString(e.did)
      let sig = bls.Signature.fromBytes(decodeBase64(e.sig))

      if (sig.verify(did.pubKey, this.msg)) {
        this.aggPubKeys.set(did.id, true)
        publicKeys.push(did.pubKey)
        sigs.push(sig)
      } else {
        errors.push(`INVALID_SIG for ${did.id}`)
      }
    }

    if (this.did) {
      publicKeys.push(this.did.pubKey)
    }
    if (this.sig) {
      sigs.push(this.sig)
    }
    const pubKey = bls.PublicKey.aggregate([...publicKeys])
    const sig = bls.Signature.aggregate([...sigs])

    this.did = new BlsDID({
      pubKey,
    })
    this.sig = sig.toBytes()

    return {
      errors,
    }
  }

  async verify(msg) {
    return bls.Signature.fromBytes(this.sig).verify(
      this.did.pubKey,
      (await encodePayload(msg)).cid.bytes,
    )
  }

  verifyPubkeys(pubKeys: Array<string>): boolean {
    let aggPub = bls.PublicKey.aggregate(
      pubKeys.map((e) => {
        return BlsDID.fromString(e).pubKey
      }),
    )
    const did = new BlsDID({
      pubKey: aggPub,
    })
    return did.id === this.did.id
  }

  serialize(circuitMap: Array<string>) {
    let bitset = new BitSet()
    for (let str in circuitMap) {
      if (this.aggPubKeys.get(circuitMap[str])) {
        bitset.set(Number(str), 1)
      }
    }
    return {
      sig: Buffer.from(this.sig).toString('base64url'),
      did: this.did.id,
      circuit: Buffer.from(bitset.toString(16), 'hex').toString('base64url'),
      circuitHex: bitset.toString(16),
    }
  }
}

void (async () => {
  await init('blst-native')
})()

export async function initBls() {
  await init('blst-native')

}
// void (async () => {

//   let msg = 'hello'
//   let date = new Date()
//   const circuit = new BlsCircuit((await encodePayload(msg as any)).cid.bytes)
//   let pubs = []
//   let useablePubs = []

//   let addList = []
//   for (let x = 0; x < 150; x++) {
//     const did = BlsDID.fromSeed(
//       Buffer.from(`5a2b1f37ecc9fb7f27e1aa3daa4d66d9c3e54a4c0dcd53a4a5cacdfaf50578/${x}`),
//     )

//     pubs.push(did.id)
//     if (Math.random() > 0.13) {
//       addList.push({
//         did: did.id,
//         sig: await did.sign(msg),
//       })
//       useablePubs.push(did.id)
//     }

//     // console.log('hello', decodeBase64(await did.sign('hello')))
//     // console.log(circuit.serialize([

//     //   did.id,

//     // ]))
//   }
//   console.log(new Date().getTime() - date.getTime())
//   circuit.addMany(addList)
//   console.log('level 1', new Date().getTime() - date.getTime())
//   console.log(await circuit.verify('hello'))
//   console.log(circuit.verifyPubkeys(useablePubs))
//   console.log(new Date().getTime() - date.getTime())
//   console.log(circuit.verifyPubkeys(useablePubs))
//   console.log(circuit.serialize(pubs), useablePubs.length)
// })()
