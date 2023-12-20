import {bech32} from 'bech32'
import {Multidid} from '@didtools/multidid'
import { BlsDID, initBls } from '../services/new/utils/crypto/bls-did'
import { sleep } from '../utils'
import { Ed25519Provider } from "key-did-provider-ed25519";
import { DID } from "dids";
import KeyResolver from 'key-did-resolver'
import Crypto from 'crypto'
import bs58check from 'bs58check';
import { ripemd160, sha256 } from 'bitcoinjs-lib/src/crypto';
import { encodePayload } from 'dag-jose-utils'
import {util} from 'ipld-dag-cbor'
import Multihashes from 'multihashes'


void (async () => {
    await initBls()
    // const did = BlsDID.fromSeed(Crypto.randomBytes(32))
    const didBls = BlsDID.fromSeed(Crypto.randomBytes(32))
    const keyPrivate = new Ed25519Provider(Crypto.randomBytes(32))
    const did = new DID({ provider: keyPrivate, resolver: KeyResolver.getResolver() })
    await did.authenticate()
    const mdBls = Multidid.fromString(didBls.id)
    console.log(Multidid.fromString(didBls.id).toBytes(), didBls.id)
    console.log(did.id)
    const md = Multidid.fromString(did.id)

    const cid = await encodePayload({})

    
    const cid2 = await util.cid(util.serialize({

    }), {
        hashAlg: Multihashes.names['ripemd-160']
    })


    const bech32Addr = bech32.encode('vs4', bech32.toWords(cid.cid.bytes));
    console.log('bech32 CID vs4', bech32Addr, bech32.fromWords(bech32.decode(bech32Addr).words), cid.cid.bytes)
    console.log('bech32 CID vs4', bech32.encode('vs4', bech32.toWords(cid.cid.bytes)).length)
    const bech32Addr2 = bech32.encode('vs4', bech32.toWords(cid2.bytes));
    console.log('bech32 CIDRIPE vs4', bech32Addr, bech32.fromWords(bech32.decode(bech32Addr2).words), cid.cid.bytes)
    
    
    console.log(md, md.toBytes())
    console.log('bech32 direct BLSG1 DID =', bech32.encode('vs2', bech32.toWords(mdBls.toBytes()), 100))
    console.log('base58 direct BLSG1 DID =', `vs1${bs58check.encode(mdBls.toBytes())}`)
    console.log('bech32 direct ed25519 DID =', bech32.encode('vs2', bech32.toWords(md.toBytes())))
    console.log('base58 direct ed25519 DID =', `vs1${bs58check.encode(md.toBytes())}`)
    console.log('bech32 RIPE160 ed25519 DID =', bech32.encode('vs2', bech32.toWords(ripemd160(Buffer.from(md.toBytes())))))
    console.log('base58 RIPE160 ed25519 DID =', `vs1${bs58check.encode(ripemd160(Buffer.from(md.toBytes())))}`)
    console.log('bech32 SHA256 ed25519 DID =', bech32.encode('vss', bech32.toWords(sha256(Buffer.from(md.toBytes())))))
    console.log('base58 SHA256 ed25519 DID =', `vs1${bs58check.encode(sha256(Buffer.from(md.toBytes())))}`)
})()