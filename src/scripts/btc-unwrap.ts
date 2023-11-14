import 'dotenv/config'
import * as bitcoin from 'bitcoinjs-lib'
import * as ecc from 'tiny-secp256k1';
import { ECPairFactory } from 'ecpair'
import Crypto from 'crypto'
import bip65 from 'bip65'
import { RegtestUtils } from 'regtest-client'
import { utils, BTCUtils, ser, ValidateSPV } from '@summa-tx/bitcoin-spv-js'
import { parseTxHex } from '../services/bitcoin-utils';
const APIPASS = process.env.APIPASS || 'satoshi'
const APIURL = process.env.APIURL || 'https://regtest.bitbank.cc/1'

const ECPair = ECPairFactory(ecc);
export const regtestUtils = new RegtestUtils({ APIPASS, APIURL })




void (async () => {
  function toOutputScript(address: string): Buffer {
      return bitcoin.address.toOutputScript(address, bitcoin.networks.bitcoin)
    }
    
    function idToHash(txid: string): Buffer {
      return Buffer.from(txid, 'hex').reverse()
    }

  const keyPair = ECPair.fromWIF(
      process.env.BTCWP_SEED,
  );
  const keyPairHacker = ECPair.makeRandom()

  const bits = Crypto.randomBytes(32)
  const payScript = bitcoin.script.compile([
      //21
      keyPair.publicKey,
      bitcoin.opcodes.OP_CHECKSIGVERIFY, //ad20
      bits,
    ]) 
    
  console.log(payScript.toString('hex'), [
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
    
    console.log('test', payScript.toString('hex').slice(payScript.toString('hex').length - 64), bits.toString('hex'))
    console.log('p2sh address', p2sh.address, p2sh.hash, Buffer.from(BTCUtils.hash160(payScript)).toString().slice(),  p2sh)
    const height = await regtestUtils.height();
    const unspent = await regtestUtils.faucet(p2sh.address, 1e5)
    const lockTime = bip65.encode({ blocks: height + 5 });
  const parsedTx = parseTxHex((await regtestUtils.fetch(unspent.txId)).txHex)

    const btcOutput = BTCUtils.extractOutputAtIndex(utils.deserializeHex(parsedTx.vout), 0)
      const val = BTCUtils.extractValue(btcOutput)
      console.log(parsedTx, Buffer.from(btcOutput), p2sh.hash, parsedTx.vout)
      console.log(Buffer.from(BTCUtils.extractHash(btcOutput)))

    



  //   const { address: returnAddress } = bitcoin.payments.p2pkh({
  //       pubkey: keyPair.publicKey,
  //       network: bitcoin.networks.regtest,
  //     })
  //     console.log(returnAddress)
  //     const tx = new bitcoin.Transaction()
  //     tx.locktime = lockTime
    
  //   //   tx.version = 2
  //     // Note: nSequence MUST be <= 0xfffffffe otherwise OP_CHECKLOCKTIMEVERIFY will fail.
  //     tx.addInput(idToHash(unspent.txId), 0, lockTime)
  //   //   tx.addInput(idToHash(tXDB.txid), 0, bip65.encode({ blocks: height + 5 }))
  //     tx.addOutput(toOutputScript(returnAddress), 8e3)
  //     const embed = bitcoin.payments.embed({data: [Crypto.randomBytes(32)]})
  //     tx.addOutput(embed.output, 0)
  //     const signatureHash = tx.hashForSignature(0, p2sh.redeem.output, bitcoin.Transaction.SIGHASH_ALL)

  //     const redeemScriptInput = bitcoin.script.compile([
  //       // bitcoin.crypto.sha256(Buffer.from("HeVGJRDdFt7WhmrVVGkxpmPP8BHWe")),
  //       bitcoin.script.signature.encode(keyPair.sign(signatureHash), bitcoin.Transaction.SIGHASH_ALL),
  //       // bitcoin.script.signature.encode(keyPairHacker.sign(signatureHash), bitcoin.Transaction.SIGHASH_ALL),
  //       // keyPair.publicKey,
  //       // bitcoin.opcodes.OP_PUSH,
  //       // Crypto.randomBytes(32),
  //       // bitcoin.opcodes.OP_DROP
  // ])
  //   const redeemScriptSig = bitcoin.payments.p2sh({
    
  //       redeem: {
  //           input: redeemScriptInput,
  //           output: p2sh.redeem.output,
  //       },
  //   })
  //   tx.setInputScript(0, redeemScriptSig.input!)
    
  //   console.log(tx.toHex())

  //   try {
  //       await regtestUtils.mine(12)
  //       await regtestUtils.broadcast(tx.toHex())
  //   } catch(ex) {
  //       console.log(ex)
  //   }
})()