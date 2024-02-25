import 'dotenv/config'
import Axios from 'axios'
import * as ecc from 'tiny-secp256k1'
import { ECPairFactory, ECPairInterface } from 'ecpair'
import NodeSchedule from 'node-schedule'
import * as IPFS from 'kubo-rpc-client'
import * as bitcoin from 'bitcoinjs-lib'
import { Collection, MongoClient, ReturnDocument } from 'mongodb'
import { utils, BTCUtils, ser, ValidateSPV } from '@summa-tx/bitcoin-spv-js'
import bs58check from 'bs58check'
import SHA256 from 'crypto-js/sha256'
import enchex from 'crypto-js/enc-hex'
import { BTCBlockStream, parseTxHex, reverse, rpcBitcoinCall } from '../../services/bitcoin-utils'
import assert from '../vendor/bsert'
import * as merkle from '../vendor/merkle'
import hash256 from '../vendor/hash256'
import { waitTxConfirm } from '../utils'
// import { TransactionPoolService } from '../../services/transactionPool'
import { CoreService } from '../../services'
import { globalConfig } from '../config'
import { sleep } from '../../utils'

const ECPair = ECPairFactory(ecc)

const CONSTANTS = {
  //Prevents relaying invalid transactions
  REPLAY_HEIGHT: 818769,
}

const BTC_WATCH_API = 'https://chain.api.btc.com/'
const MEMPOOL_API = 'https://mempool.space'
const BTC_NODE_API = 'http://149.56.25.168:8332'
const CONTRACT_ID = globalConfig.btcTokenContract
const BTCCR_CONTRACT = '42fe0195bb2fe0afe7e015871d8c5749d07177cc'

const STATE_GQL = `
query MyQuery($contractId: String) {
    contractState(id: $contractId) {
      state_merkle
      id
    }
  }
`

interface TxInfo {
  status: 'pending' | 'confirmed'
  amount: number
  type: 'redeem' | 'deposit'
  tx_id: string
  [x: string]: any
}

async function getMerkleProof(txid, height) {
  let blockhash
  if (typeof height === 'number') {
    blockhash = (await rpcBitcoinCall('getblockhash', [height])).result
  } else {
    blockhash = height
  }
  const block = (await rpcBitcoinCall('getblock', [blockhash])).result

  // console.log('hHELLO')
  // console.log(block)
  let index = -1
  const txs = []
  for (const [i, tx] of Object.entries(block.tx) as any) {
    if (tx === txid) {
      index = i >>> 0
    } // cast to uint from string
    txs.push(Buffer.from(tx, 'hex').reverse())
  }

  assert(index >= 0, 'Transaction not in block.')

  const [root] = merkle.createRoot(hash256, txs.slice())
  // assert.bufferEqual(Buffer.from(block.merkleroot, 'hex').reverse(), root);

  const branch = merkle.createBranch(hash256, index, txs.slice())
  // console.log('root', root, branch)

  const proof = []
  for (const hash of branch) {
    proof.push(hash.toString('hex'))
  }

  return [proof, index]
}

async function createProof(tx_id: string) {
  const dataTx = (await rpcBitcoinCall('getrawtransaction', [tx_id, 1])).result

  const merkleProof = await getMerkleProof(tx_id, dataTx.blockhash)
  const vinProf = parseTxHex(dataTx.hex)

  const blockHeader = (await rpcBitcoinCall('getblockheader', [dataTx.blockhash])).result
  const blockHeaderRaw = (await rpcBitcoinCall('getblockheader', [dataTx.blockhash, false])).result
  // console.log((merkleProof[0] as any).length, (merkleProof[0] as any).reduce((a, b) => a + b))

  // console.log(merkleProof)
  const fullProof = {
    ...vinProf,
    intermediate_nodes:
      (merkleProof[0] as any).length > 2 ? (merkleProof[0] as any).reduce((a, b) => a + b) : '',
    index: merkleProof[1],
    tx_id: reverse(tx_id),
    confirming_header: {
      raw: blockHeaderRaw,
      hash: reverse(blockHeader.hash),
      height: typeof blockHeader.height === 'number' ? blockHeader.height : blockHeader.height,
      prevhash: reverse(blockHeader.previousblockhash),
      merkle_root: reverse(blockHeader.merkleroot),
    },
    confirming_height: blockHeader.height,
  }
  // console.log('fullProof', fullProof)

  try {
    let validProof = ValidateSPV.validateProof(ser.deserializeSPVProof(JSON.stringify(fullProof)))
    // console.log('validProof', validProof, fullProof)
  } catch (ex) {
    console.log(ex)
  }
  return {
    ...vinProf,
    intermediate_nodes:
      (merkleProof[0] as any).length > 2 ? (merkleProof[0] as any).reduce((a, b) => a + b) : '',
    index: merkleProof[1],
    tx_id: reverse(tx_id),
    confirming_height: blockHeader.height,
  }
}

function toOutputScript(address: string): Buffer {
  return bitcoin.address.toOutputScript(address, bitcoin.networks.bitcoin)
}

function idToHash(txid: string): Buffer {
  return Buffer.from(txid, 'hex').reverse()
}

function compileScript(pubKey: string, addrKey: string) {
  return Buffer.from(`21${pubKey}ad20${addrKey}`, 'hex')
}

export class BitcoinWrappingProvider {
  privateKey: ECPairInterface
  ipfs: IPFS.IPFSHTTPClient
  returnAddress: string
  txDb: Collection
  addrDb: Collection
  transactionPool: any
  core: CoreService

  async getStateRoot(): Promise<string> {
    const { data } = await Axios.post(`http://localhost:1337/api/v1/graphql`, {
      query: STATE_GQL,
      variables: {
        contractId: CONTRACT_ID,
      },
    })

    const state_merkle = data?.data?.contractState?.state_merkle

    return state_merkle
  }

  async getTXFees() {
    const { data } = await Axios.get(`${MEMPOOL_API}/api/v1/fees/recommended`)

    console.log('data.hourFee', data.hourFee)
    return data.hourFee
  }

  async getAllAddrs() {
    const state_merkle = await this.getStateRoot()

    console.log('state_merkle', state_merkle)
    let btcAddrs = []
    try {
      const listPathsCid = await this.ipfs.dag.resolve(IPFS.CID.parse(state_merkle), {
        path: 'btc_addrs',
      })

      const data2 = await this.ipfs.dag.get(listPathsCid.cid)

      if (data2.value.Links) {
        for (let Link of data2.value.Links) {
          btcAddrs.push({
            addr: Link.Name,
            data: (await this.ipfs.dag.get(Link.Hash)).value,
          })
        }
      }
      // console.log(data2.value)
      // console.log(btcAddrs)
    } catch (ex) {
      if (!ex.message.includes('no link named')) {
        console.log(ex)
      }
    }
    return btcAddrs
  }

  async getCurrentWraps() {
    let wrapsList = []
    const state_merkle = await this.getStateRoot()
    try {
      const listPathsCid = await this.ipfs.dag.resolve(IPFS.CID.parse(state_merkle), {
        path: 'wraps',
      })

      const data2 = await this.ipfs.dag.get(listPathsCid.cid)

      // console.log(data2.value)
      if (data2.value.Links) {
        for (let Link of data2.value.Links) {
          wrapsList.push(Link.Name)
        }
      }
      // console.log(wrapsList)
    } catch (ex) {
      if (!ex.message.includes('no link named')) {
        console.log(ex)
      }
    }
    return wrapsList
  }

  async getCurrentRedeems() {
    const state_merkle = await this.getStateRoot()

    let redeemRequests = []
    try {
      const listPathsCid = await this.ipfs.dag.resolve(IPFS.CID.parse(state_merkle), {
        path: 'redeems',
      })

      const data2 = await this.ipfs.dag.get(listPathsCid.cid)

      if (data2.value.Links) {
        for (let Link of data2.value.Links) {
          const dagData = await this.ipfs.dag.get(Link.Hash)

          redeemRequests.push({
            ...dagData.value,
            id: Link.Name,
          })
        }
      }
    } catch (ex) {
      if (!ex.message.includes('no link named')) {
        console.log(ex)
      }
    }
    return redeemRequests
  }

  async submitBTCTx(hex: string) {
    const { data } = await Axios.post(BTC_NODE_API, {
      jsonrpc: '1.0',
      id: 'curltest',
      method: 'sendrawtransaction',
      params: [hex],
    })

    return data
  }
  
  async checkBTCTx(txId: string) {
    try {
      const {data} = await Axios.get(`${MEMPOOL_API}/api/tx/${txId}`)
      
    
      console.log({
        confirmed: data.status.confirmed,
        block_height: data.status.block_height
      })
      return {
        confirmed: data.status.confirmed,
        block_height: data.status.block_height
      }
    } catch (ex) {
      console.log(ex.response)
    }

  }
  
  async readKey(key: string) {
    const state_merkle = await this.getStateRoot()

    let redeemRequests = []
    try {
      const listPathsCid = await this.ipfs.dag.resolve(IPFS.CID.parse(state_merkle), {
        path: key,
      })

      const data2 = await this.ipfs.dag.get(listPathsCid.cid)

      if (data2.value.Links) {
        for (let Link of data2.value.Links) {
          const dagData = await this.ipfs.dag.get(Link.Hash)

          redeemRequests.push({
            ...dagData.value,
            id: Link.Name,
          })
        }
      }
    } catch (ex) {
      if (!ex.message.includes('no link named')) {
        console.log(ex)
      }
    }
    return redeemRequests
  }

  async getUTXOs(addr: string) {
    try {
      const { data } = await Axios.get(`${MEMPOOL_API}/api/address/${addr}/utxo`)
  
      // console.log('utxo list', data)
      return data
        .filter((e) => e.status.confirmed === true)
        .filter((e) => e.status.block_height > CONSTANTS.REPLAY_HEIGHT)
    } catch (ex) {
      console.log(ex)
      return []
    }
  }

  async redeem(redeemInfo) {
    console.log(redeemInfo)
    const amount = redeemInfo.balance * 100_000_000
    const pendingTx = new bitcoin.Transaction()
    const psbt = new bitcoin.Psbt()

    let returnAmount = 0
    const pendingAmount = 0
    const inputs: Array<{ id: string; vout: number; address: string }> = []

    for (let { addr } of await this.getAllAddrs()) {
      for (let utxo of await this.getUTXOs(addr)) {
        const convertAmt = utxo.value
        // console.log('convertAmt', convertAmt)

        const dataTx = (await rpcBitcoinCall('getrawtransaction', [utxo.txid, 1])).result
        // console.log('dataTx', dataTx.vout[utxo.vout])
        if (convertAmt >= amount) {
          returnAmount = returnAmount + (convertAmt - amount)
        }

        inputs.push({
          id: utxo.txid,
          vout: utxo.vout,
          address: dataTx.vout[utxo.vout].scriptPubKey.address,
        })
      }
    }
    // console.log(redeemInfo)

    psbt.setMaximumFeeRate(30)
    // pendingTx.addInput()
    //Take 1% fee
    const estimatedSize = 250; //Assumed size
    const gasFee = estimatedSize * (await this.getTXFees())
    const outAmount = amount * 0.99 - gasFee
    returnAmount = returnAmount + amount * 0.01

    // console.log(outAmount, amount)

    pendingTx.addOutput(toOutputScript(redeemInfo.address), Math.round(outAmount))

    const embed = bitcoin.payments.embed({ data: [Buffer.from(redeemInfo.id, 'hex')] })
    pendingTx.addOutput(embed.output, 0)
    pendingTx.addOutput(toOutputScript(this.returnAddress), Math.round(returnAmount))

    for (let input of inputs) {
      const destHash = await this.addrDb.findOne({
        addr: input.address,
      })

      if (!destHash) {
        return
      }

      console.log('sha256 - destAddr', SHA256(destHash.data.val).toString(enchex))
      const verifyBuf = Buffer.from(SHA256(destHash.data.val).toString(enchex), 'hex')
      const payScript = bitcoin.script.compile([
        this.privateKey.publicKey,
        bitcoin.opcodes.OP_CHECKSIGVERIFY, //ad20
        verifyBuf,
      ])

      const buf = BTCUtils.hash160(
        compileScript(this.privateKey.publicKey.toString('hex'), verifyBuf.toString('hex')),
      )
      const hashBuf = new Uint8Array(21)
      hashBuf.set([5])
      hashBuf.set(buf, 1)

      const p2sh = bitcoin.payments.p2sh({
        redeem: {
          output: payScript,
        },
        network: bitcoin.networks.bitcoin,
      })
      // console.log(this.privateKey.publicKey.toString('hex'), bs58check.encode(hashBuf), p2sh.address)

      const index = pendingTx.addInput(idToHash(input.id), input.vout)
      const signatureHash = pendingTx.hashForSignature(
        index,
        p2sh.redeem.output,
        bitcoin.Transaction.SIGHASH_ALL,
      )
      console.log(signatureHash)

      const redeemScriptInput = bitcoin.script.compile([
        bitcoin.script.signature.encode(
          this.privateKey.sign(signatureHash),
          bitcoin.Transaction.SIGHASH_ALL,
        ),
      ])

      const redeemScriptSig = bitcoin.payments.p2sh({
        redeem: {
          input: redeemScriptInput,
          output: p2sh.redeem.output,
        },
      })
      console.log('pendingTx.index', index)

      pendingTx.setInputScript(index, redeemScriptSig.input)
    }
    console.log(pendingTx.toHex(), pendingTx.toBuffer().length, pendingTx.virtualSize())
    console.log('txId - redeem', pendingTx.getId())
    
    //await this.submitBTCTx(pendingTx.toHex())
  }

  async depositProof(utxo, allWraps) {
    if (CONSTANTS.REPLAY_HEIGHT > utxo.status.block_height) {
      console.log('depositProof.end case 1')
      return
    }
    if(allWraps.includes(utxo.txid)) {
      console.log('depositProof.end case 2', utxo.txid)
      return;
    }

    const activeTx = await this.txDb.findOne({
      ref_id: utxo.txid
    })
    
    if(activeTx) {
      console.log('depositProof.end case 3', utxo.txid)
      return;
    }

    console.log('creating deposit proof', utxo)
    const proof = await createProof(utxo.txid)
    const result = await this.transactionPool.callContract(CONTRACT_ID, {
      action: 'mint',
      payload: {
        proof,
      },
    })
    await this.txDb.updateOne({
      tx_id: result.id,
      ref_id: utxo.txid
    }, {
      $set: {
        status: 'pending'
      }
    }, {
      upsert: true
    })
    const date = new Date()
    await waitTxConfirm(result.id, this.core, (state) => {
      if (state === 'INCLUDED') {
        console.log(`depositProof status=included after=${new Date().getTime() - date.getTime()}ms`)
      }
    })
    console.log(`depositProof status=confirmed after=${new Date().getTime() - date.getTime()}ms`)
    await this.txDb.updateOne({
      tx_id: result.id,
      ref_id: utxo.txid
    }, {
      $set: {
        status: 'confirmed'
      }
    }, {
      upsert: true
    })
  }
  
  async redeemProof(txId) {
    const proof = await createProof(txId)
    if (CONSTANTS.REPLAY_HEIGHT > proof.confirming_height) {
      return
    }
    const activeTx = await this.txDb.findOne({
      type: 'redeemProof',
      ref_id: txId
    })

    if(activeTx) {
      return;
    }
    const result = await this.transactionPool.callContract(CONTRACT_ID, {
      action: 'redeemProof',
      payload: {
        proof,
      },
    })
    const date = new Date()

    await this.txDb.updateOne({
      type: 'redeemProof',
      tx_id: result.id,
      ref_id: txId
    }, {
      $set: {
        status: 'pending'
      }
    }, {
      upsert: true
    })
    
    await waitTxConfirm(result.id, this.core, (state) => {
      if (state === 'INCLUDED') {
        console.log(`redeemProof status=included after=${new Date().getTime() - date.getTime()}ms`)
      }
    })
    // console.log('Confirmed after', new Date().getTime() - date.getTime(), 's')
    console.log(`redeemProof status=confirmed after=${new Date().getTime() - date.getTime()}ms`)
    await this.txDb.updateOne({
      type: 'redeemProof',
      tx_id: result.id,
      ref_id: txId
    }, {
      $set: {
        status: 'confirmed'
      }
    }, {
      upsert: true
    })
  }

  async poll() {
    const allWraps = await this.getCurrentWraps()
    for (let { addr, data } of await this.getAllAddrs()) {
      await this.addrDb.findOneAndUpdate(
        {
          addr,
        },  
        {
          $set: {
            data,
          },
        },
        {
          upsert: true,
        },
      )
      for (let utxo of await this.getUTXOs(addr)) {
        await this.depositProof(utxo, allWraps)
      }
    }

    for (let redeem of await this.getCurrentRedeems()) {
      await this.redeem(redeem)
    }

    // await this.redeemProof('bff73a4ad4b34f198c8c0e743ca839398d1e75f9bbb6973edf36f9b2d1188b33')

    // const transactions = (await Axios.get(`${BTC_WATCH_API}/v3/address/${btcAddr}/tx`)).data.data?.list
    // console.log(transactions)
    // if(transactions) {
    //     for(let tx of transactions) {

    //     }
    // }
  }
 
  async pollTxCheck() {
    const txs = await this.txDb.find({
      type: "redeem",
      status: "pending"
    }).toArray()
    for(let tx of txs) {
      // console.log(tx)
    }
  }

  /**
   * Help keep chain relay up to date
   */
  async replayBtcBlocks() {
    for (;;) {
      try {
        let x = 0
        let topBlock = 0
        // while (topBlock < 840_000) {
        //   const { state_merkle } = await this.core.newService.contractEngine.contractDb.findOne({
        //     id: BTCCR_CONTRACT,
        //   })
        //   // console.log('state merkle', state_merkle)
        //   try {
        //     const dag = await this.core.ipfs.dag.resolve(IPFS.CID.parse(state_merkle), {
        //       path: 'pre-headers/main',
        //     })

        //     topBlock =
        //       Object.entries((await this.core.ipfs.dag.get(dag.cid)).value)
        //         .map((e) => {
        //           return (e[1] as any).height
        //         })
        //         .sort((a, b) => {
        //           return b - a
        //         })[0] || 0
        //     // console.log('topBlock', topBlock)
        //   } catch (ex) {
        //     console.log(ex)
        //     topBlock = 0
        //   }
        //   // console.log(state_merkle, topBlock)
        //   const abortController = new AbortController()
        //   let headerBulk = [] as any

        //   const transactionPool = this.transactionPool
        //   const core = this.core
        //   let busyPromise

        //   async function processHeadersTx() {
        //     const localCopy = headerBulk
        //     headerBulk = []
        //     if (localCopy.length < 1) {
        //       return
        //     }
        //     const result = await transactionPool.callContract(BTCCR_CONTRACT, {
        //       action: 'processHeaders',
        //       payload: {
        //         headers: localCopy,
        //       },
        //     })
        //     await sleep(5_000)
        //     core.logger.debug('result of contract invokation', result)
        //     const date = new Date()
        //     await waitTxConfirm(result.id, core, (state) => {
        //       if (state === 'INCLUDED') {
        //         // console.log('Included after', new Date().getTime() - date.getTime(), 's')
        //       }
        //     })
        //     // console.log('Confirmed after', new Date().getTime() - date.getTime(), 's')
        //     await sleep(30_000)
        //   }

        //   setInterval(() => {
        //     busyPromise = processHeadersTx()
        //   }, 30_000)
        //   // setInterval(() => {
        //   //     console.log(headerBulk)
        //   // }, 15_000)

        //   for await (let header of BTCBlockStream({
        //     height: topBlock + 1,
        //     signal: abortController.signal,
        //     continueHead: true,
        //   })) {
        //     // break;
        //     // console.log(header)
        //     headerBulk.push(header.rawData)
        //     // console.log('pushing', header.x, header.data.hash)
        //     // const decodeHex = new Uint8Array(Buffer.from(header, 'hex'))
        //     // const prevBlock = reverse(BTCUtils.extractPrevBlockLE(decodeHex));
        //     if (headerBulk.length > 144) {
        //       busyPromise = processHeadersTx()
        //     }
        //     if (busyPromise) {
        //       await busyPromise
        //       busyPromise = null
        //       break
        //     }
        //   }
        // }
      } catch (ex) {
        console.log(ex)
      }
    }
  }

  async getReplayedBlock(): Promise<number> {
    // let topBlock;
    // const { state_merkle } = await this.core.newService.contractEngine.contractDb.findOne({
    //   id: BTCCR_CONTRACT,
    // })
    // // console.log('state merkle', state_merkle)
    // try {
    //   const dag = await this.core.ipfs.dag.resolve(IPFS.CID.parse(state_merkle), {
    //     path: 'pre-headers/main',
    //   })

    //   topBlock =
    //     Object.entries((await this.core.ipfs.dag.get(dag.cid)).value)
    //       .map((e) => {
    //         return (e[1] as any).height
    //       })
    //       .sort((a, b) => {
    //         return b - a
    //       })[0] || 0
    //   // console.log('topBlock', topBlock)
    // } catch (ex) {
    //   console.log(ex)
    //   topBlock = 0
    // }
    // return topBlock
    return 0
  }

  async start() {
    this.ipfs = IPFS.create({ url: 'http://127.0.0.1:5001' })
    this.privateKey = ECPair.fromWIF(process.env.BTCWP_SEED)
    const { address: returnAddress } = bitcoin.payments.p2pkh({
      pubkey: this.privateKey.publicKey,
      network: bitcoin.networks.bitcoin,
    })
    this.returnAddress = returnAddress

    const client = new MongoClient('mongodb://localhost:27017')
    await client.connect()
    const db = client.db('vsc-wp')
    this.txDb = db.collection('tx-db')
    this.addrDb = db.collection('addrs')

    const core = new CoreService({
      prefix: 'manual tx core',
      printMetadata: true,
      level: 'debug',
      mode: 'lite',
    })

    await core.start()

    // const transactionPool = new TransactionPoolService(core)

    // await transactionPool.start()

    this.core = core

    // this.transactionPool = transactionPool

    NodeSchedule.scheduleJob('*/5 * * * *', async () => {
      try {
        // await this.getTXFees()
        // await this.poll()
      } catch (ex) {
        console.log(ex)
      }
    })
    // await this.poll()
    this.replayBtcBlocks()
    await this.checkBTCTx('4aa5030b514f3aac5fc763ec0af8ee14de32879d80416421d22f54af1f4455fc')
  }
}

void (async () => {
  const WProvider = new BitcoinWrappingProvider()

  await WProvider.start()
})()
