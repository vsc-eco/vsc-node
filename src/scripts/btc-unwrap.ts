import 'dotenv/config'
import * as bitcoin from 'bitcoinjs-lib'
import * as ecc from 'tiny-secp256k1';
import { ECPairFactory } from 'ecpair'
import Crypto from 'crypto'
import bip65 from 'bip65'
import { RegtestUtils } from 'regtest-client'
import { utils, BTCUtils, ser, ValidateSPV } from '@summa-tx/bitcoin-spv-js'
import {bech32m} from 'bech32'
import { parseTxHex } from '../services/bitcoin-utils';
const APIPASS = process.env.APIPASS || 'satoshi'
const APIURL = process.env.APIURL || 'https://regtest.bitbank.cc/1'

const ECPair = ECPairFactory(ecc);
export const regtestUtils = new RegtestUtils({ APIPASS, APIURL })




void (async () => {
  function toOutputScript(address: string): Buffer {
      return bitcoin.address.toOutputScript(address, bitcoin.networks.testnet)
    }
    
    function idToHash(txid: string): Buffer {
      return Buffer.from(txid, 'hex').reverse()
    }

  const keyPair = ECPair.fromWIF(
      process.env.BTCWP_SEED,
  );
  const keyPairHacker = ECPair.makeRandom()

  console.log(bech32m.encode('vsc2', bech32m.toWords(Buffer.from('fooooobar'))))

  console.log('publicKey hex', keyPair.publicKey.toString('hex'))
  const bits = Crypto.randomBytes(32)
  const payScript = bitcoin.script.compile([
      //21
      keyPair.publicKey,
      bitcoin.opcodes.OP_CHECKSIGVERIFY, //ad20
      bits,
    ]) 
    
    function compileScript(pubKey: string, addrKey: string) {
      return Buffer.from(`21${pubKey}ad20${addrKey}`, 'hex')
  }
  
  console.log('compiled script', payScript.toString('hex'), [
    keyPair.publicKey.toString('hex'),
    bitcoin.opcodes.OP_CHECKSIGVERIFY,
    bits.toString('hex'),
  ])

  const p2sh = bitcoin.payments.p2sh({
      redeem: {
        output: payScript,
      },
      network: bitcoin.networks.testnet,
    });
  const p2wsh = bitcoin.payments.p2wsh({
      redeem: {
        output: payScript,
      },
      network: bitcoin.networks.bitcoin,
    });

    console.group('p2wsh.address', p2wsh.address)
    
    //console.log('test', payScript.toString('hex').slice(payScript.toString('hex').length - 64), bits.toString('hex'))
    const hash = Buffer.from(BTCUtils.hash160(compileScript("034240ccd025374e0531945a65661aedaac5fff1b2ae46197623e594e0129e8b13",bits.toString('hex'))))
    const endArray = new Uint8Array(21)
    endArray.set([0x05])
    endArray.set(hash, 1)
    console.log('p2sh address', p2sh.address, p2sh.hash, hash)
    const height = await regtestUtils.height();
    const unspent = await regtestUtils.faucet(p2sh.address, 1e5)
    const lockTime = bip65.encode({ blocks: height + 5 });
  // const parsedTx = parseTxHex((await regtestUtils.fetch(unspent.txId)).txHex)

  //   const btcOutput = BTCUtils.extractOutputAtIndex(utils.deserializeHex(parsedTx.vout), 0)
  //     const val = BTCUtils.extractValue(btcOutput)
  //     console.log(parsedTx, Buffer.from(btcOutput), p2sh.hash, parsedTx.vout)
  //     console.log(Buffer.from(BTCUtils.extractHash(btcOutput)))

    



    const { address: returnAddress } = bitcoin.payments.p2pkh({
        pubkey: keyPair.publicKey,
        network: bitcoin.networks.testnet,
      })
  //     console.log(returnAddress)
      const tx = new bitcoin.Transaction()
      tx.locktime = lockTime
    
  //   //   tx.version = 2
  //     // Note: nSequence MUST be <= 0xfffffffe otherwise OP_CHECKLOCKTIMEVERIFY will fail.
      tx.addInput(idToHash(unspent.txId), 0, lockTime)
  //   //   tx.addInput(idToHash(tXDB.txid), 0, bip65.encode({ blocks: height + 5 }))
      tx.addOutput(toOutputScript(returnAddress), 8e3)
      //     const embed = bitcoin.payments.embed({data: [Crypto.randomBytes(32)]})
      //     tx.addOutput(embed.output, 0)
      const signatureHash = tx.hashForSignature(0, p2sh.redeem.output, bitcoin.Transaction.SIGHASH_ALL)
      
      const redeemScriptInput = bitcoin.script.compile([
        // bitcoin.crypto.sha256(Buffer.from("HeVGJRDdFt7WhmrVVGkxpmPP8BHWe")),
        bitcoin.script.signature.encode(keyPair.sign(signatureHash), bitcoin.Transaction.SIGHASH_ALL),
        // bitcoin.script.signature.encode(keyPairHacker.sign(signatureHash), bitcoin.Transaction.SIGHASH_ALL),
        // keyPair.publicKey,
        // bitcoin.opcodes.OP_PUSH,
        // Crypto.randomBytes(32),
        // bitcoin.opcodes.OP_DROP
      ])
      const redeemScriptSig = bitcoin.payments.p2sh({
        
        redeem: {
            input: redeemScriptInput,
            output: p2sh.redeem.output,
          },
        })
        console.log(tx.virtualSize())
        tx.setInputScript(0, redeemScriptSig.input!)
    
  //   console.log(tx.toHex())

  //   try {
  //       await regtestUtils.mine(12)
  //       await regtestUtils.broadcast(tx.toHex())
  //   } catch(ex) {
  //       console.log(ex)
  //   }
})()