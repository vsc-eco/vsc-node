
import { encodePayload } from 'dag-jose-utils'
import networks from "../../../services/networks";
import { NewCoreService } from "..";
import { HiveClient, sleep } from "../../../utils";
import { BlsCircuit, BlsDID } from '../utils/crypto/bls-did';
import { Collection } from 'mongodb';
import { CID } from 'multiformats';
import IPLDDag from 'ipld-dag-cbor'

import { BlockHeader, TransactionDbStatus, TransactionDbType } from '../types';
import { PrivateKey } from '@hiveio/dhive';
import { DelayMonitor } from './delayMonitor';
import { simpleMerkleTree } from '../utils/crypto';
import { computeKeyId, sortTransactions } from '../utils';

const Constants = {
  block_version: 1
}

export const BlockVersions = {
  1: {

  }
}
export enum FlagMap {
  
}



export class BlockContainer {
    rawData: {
      __t: 'vsc-block',
      __v: number,
      headers?: {
        //Previous block header
        prevb: null | string
        //Block range start - finish
        br: [number, number]
      }
      //The only difference between BlockContainer and header is header does not include Txs and header is only signed
      txs: Array<{
        id: string
        type: string
      }>,
      merkle_root: string,
      mmr_root?: string
    };
    ref_start: number;
    ref_end: number
    constructor(rawData) {
      this.rawData = rawData
    }

    async toHeader() {
      const block = await encodePayload(this.rawData)
      

      // let mmr = new InMemoryMMR()

      // const appendResult = await mmr.append(this.rawData.merkle_root || 'hello')

      // console.log(appendResult)

      // console.log(mmr)

      
      // console.log(MemoryStore)
      
      // const store = new (MemoryStore as any).default();
      // const hasher = new KeccakHasher();

      // console.log(Mmr)
      // const mmr = new (Mmr as any).default(store, hasher);

      // await mmr.append("1");
      // await mmr.append("2");
      // await mmr.append("3");
      // const { elementIndex } = await mmr.append("4");
      // await mmr.append("5");

      // const proof = await mmr.getProof(elementIndex);

      // console.log(await mmr.verifyProof(proof, "4")); // true

      return {
        __t: "vsc-bh",
        __v: '0.1',
        headers: {
          //Find previous block here
          prevb: this.rawData.headers?.prevb || null,
          //block range
          br: [this.ref_start, this.ref_end]
        },
        merkle_root: this.rawData.merkle_root,
        // mmr_root: this.rawData.mmr_root,
        block: CID.parse(block.cid.toString())
      }
    }

    toObject() {
      return this.rawData
    }

    static fromObject(rawData): BlockContainer {
      return new BlockContainer(rawData)
    }
}



export class WitnessServiceV2 {
    self: NewCoreService;
    witnessSchedule: {
        valid_to?: Number | null
        valid_from?: Number | null
        schedule?: Array<any>
    }
    //Precomputed list of blocks
    _candidateBlocks: Record<string, any>
    candidateApprovalsDb: Collection
    //VSC block headres ref
    blockHeaders: Collection<BlockHeader>
    delayMonitor: DelayMonitor;

    constructor(self: NewCoreService) {
        this.self = self;
        

        this.delayMonitor = new DelayMonitor(this.self, this)


        this.blockParser = this.blockParser.bind(this)
        this.handleProposeBlockMsg = this.handleProposeBlockMsg.bind(this)

        this.witnessSchedule = {
            valid_to: null
        }
        this._candidateBlocks = {

        }
    }


 
    async weightedSchedule(totalRounds, blockHeight: number) {

        const blockLast = await this.self.chainBridge.streamState.findOne({
          id: 'last_hb_processed'
        })
        const consensusRound = await this.calculateConsensusRound(blockHeight)
        let witnessNodes = await this.self.chainBridge.getWitnessesAtBlock(blockHeight)
        witnessNodes = witnessNodes.sort((a, b) => {
          return a.account - b.account;
        })


        let outSchedule = []
        for (let x = 0; x < totalRounds; x++) {
          if (witnessNodes[x % witnessNodes.length]) {
            outSchedule.push(witnessNodes[x % witnessNodes.length])
          }
        }
    
        outSchedule = await this.applyBNSchedule(outSchedule, blockHeight)

        return {
            schedule: outSchedule,
            valid_from: outSchedule[0]?.bn || 0,
            valid_to: outSchedule[outSchedule.length - 1]?.bn || 1
        }
      }
    
      async calculateConsensusRound(blockNumber) {
        const {roundLength, totalRounds} = networks[this.self.config.get('network.id')];
        // const blockNumber = await HiveClient.blockchain.getCurrentBlockNum()
    
        
    
        const modLength = roundLength * totalRounds
        const mod3 = blockNumber % modLength
        const pastRoundHash = blockNumber - mod3
        
    
        return {
          nextRoundHash: blockNumber + (modLength - mod3),
          pastRoundHash,
          currentBlockNumber: blockNumber,
        }
      }
    
      /**
       * Applies block numbers to witness schedule
       */
      async applyBNSchedule(schedule: any[], blockHeight: number) {
        const consensusRound = await this.calculateConsensusRound(blockHeight)
        const roundLength = networks[this.self.config.get('network.id')].roundLength;
    
        return schedule.map((e, index) => {
          return {
            ...e,
            bn: consensusRound.pastRoundHash + index * roundLength,
            bn_works: (consensusRound.pastRoundHash + index * roundLength) % roundLength === 0,
            in_past: consensusRound.pastRoundHash + index * roundLength < consensusRound.currentBlockNumber,
          }
        })
      }

     async calcSlotInfo(blockHeight: number) {
      const consensusRound = await this.calculateConsensusRound(blockHeight)
      const roundLength = networks[this.self.config.get('network.id')].roundLength;
  
      return {
        slot_start: consensusRound.pastRoundHash + blockHeight % roundLength,
        slot_end: (consensusRound.pastRoundHash + blockHeight % roundLength) + roundLength,
      }
    }

    
    async createBlock(args: {
      start_height: number
      end_height: number
    }): Promise<BlockContainer> {
      const {end_height, start_height} = args;
      console.log('Gettting transactions query', {
        status: TransactionDbStatus.included,
        'anchored_height': {
          $lte: end_height,
          $gte: start_height - 1 //Account for calculated anchored_height. Note: revise this in the future.
        },
        $or: [
          {
            //Make sure transactions are locked in the future
            'headers.lock_block': {
              $gt: start_height
            }
          }, {
            'headers.lock_block': {
              $exists: false
            }
          }
        ]
      })
      const transactions = await this.self.transactionPool.txDb.find({
        status: TransactionDbStatus.included,
        'anchored_height': {
          $lte: end_height,
          $gte: start_height - 1
        },
        $or: [
          {
            //Make sure transactions are locked in the future
            'headers.lock_block': {
              $gt: start_height
            }
          }, {
            'headers.lock_block': {
              $exists: false
            }
          }
        ]
      }, {
        sort: {
          anchored_height: 1,
          anchored_index: 1
        }
      }).toArray()
      console.log('TO EXECUTE', transactions)

      const offchainTxsUnfiltered = await this.self.transactionPool.txDb.find({
        status: TransactionDbStatus.unconfirmed,
        src: 'vsc',
        
        $or: [
          {
            //Make sure transactions are locked in the future
            'headers.lock_block': {
              $gt: start_height
            }
          }, {
            'headers.lock_block': {
              $exists: false
            }
          }
        ],
      }, {
        sort: {
          "headers.nonce": 1,
          first_seen: -1
        }
      }).toArray()

      const nonceMap:Record<string, number> = {}
      const offchainTxs = []
      for(let tx of offchainTxsUnfiltered) {
        const keyId = await computeKeyId(tx.required_auths.map(e => e.value))
        if(!nonceMap[keyId]) {
          const nonceRecord = await this.self.nonceMap.findOne({
            id: keyId
          })
          if(!nonceRecord) {
            //Assume zero nonce
            nonceMap[keyId] = 0;
          } else {
            nonceMap[keyId] = nonceRecord.nonce
          }
        }
        if(nonceMap[keyId] === tx.headers.nonce) {
          offchainTxs.push(tx)
          nonceMap[keyId] = nonceMap[keyId] + 1;
        } else {
          //Skip insertion because of invald nonce. 
          //Prioritize TXs with latest first_seen as subjective replace by time 
          continue; 
        }
      }

      const onchainTxs = transactions.filter(e => {
        return e.src === 'hive'
      })

     
      
      let hiveMerkleProof = {
        id: null,
        data: null,
        chain: 'hive',
        type: TransactionDbType.anchor_ref
      }

      if(onchainTxs.length > 0) {
        const txIds = onchainTxs.map(e => CID.parse(e.id).bytes);
        const root = simpleMerkleTree(txIds)
        // console.log(root)
        // const proof = tree.getProof(SHA256(txIds[0]))
        // console.log(proof)
        // console.log('onchainTxs', onchainTxs.map(e => e.id))
        hiveMerkleProof.id = await this.self.ipfs.dag.put({
          txs: txIds
        })
        hiveMerkleProof.data = root;
      }

      // const contractIds = await this.self.transactionPool.txDb.distinct('headers.contract_id', {
      //   $or: [
      //     {
      //       'headers.lock_block': {
      //         $gt: end_height
      //       }
      //     }, {
      //       'headers.lock_block': {
      //         $exists: false
      //       }
      //     }
      //   ]
      // })

      let contractIdsOut = {}
      for(let tx of transactions) {
        if((tx?.data as any)?.contract_id) {
          contractIdsOut[(tx.data as any).contract_id] = 1;
        }
      }
      const contractIds = Object.keys(contractIdsOut)

      console.log(contractIds)

      let contractOutputs = []
      if(transactions.length > 0 && contractIds.length > 0) {
        
        console.log('contractIds', contractIds)
        const vmContext = this.self.contractEngine.vmContext(contractIds);
        await vmContext.init()
        
        let results: Record<string, Array<any>> = {

        }
  
        for(let tx of transactions) {
          if(tx.data.contract_id) {
            const contract_id = tx.data.contract_id
            const contractCallResult = await vmContext.processTx(tx)
            if(!results[contract_id]) {
              results[contract_id] = []
            }
            results[contract_id].push({
              id: tx.id,
              result: {
                ret: contractCallResult.ret,
                error: contractCallResult.error,
                errorType: contractCallResult.errorType,
                logs: contractCallResult.logs,
                IOGas: contractCallResult.IOGas
              }
            })
          }
        }
        for(let out of await vmContext.finish()) {

          const outputData = {
            __t: 'vsc-output',
            __v: '0.1',

            
            contract_id: out.contract_id,
            remote_calls: [],
            //Either TX ID or @remote/<index>
            inputs: results[out.contract_id].map(e => e.id),
            results: results[out.contract_id].map(e => e.result),
            state_merkle: out.stateMerkle,
            io_gas: results[out.contract_id].map(e => e.result.IOGas).reduce((a, b) => {
              return a + b;
            })
          }
          console.log(outputData, out)
          contractOutputs.push({
            id: (await this.self.ipfs.dag.put(outputData)).toString(),
            contract_id: outputData.contract_id,
            type: TransactionDbType.output
          })
        }
      }
      
      // for(let contractId of contractIds) {
      //   const output = await this.self.contractEngine.createContractOutput({
      //     txs: contractTxs,
      //     contract_id: contractId
      //   })
        
      //   //Store unsigned outputs for now.
      //   const outputCid = await this.self.ipfs.dag.put(output)

      //   contractOutputs.push({
      //     id: outputCid,
      //     type: TransactionDbType.output
      //   })
      // }

      const txList = [
        ...offchainTxs.map(e => {
          return {
            id: e.id,
            op: e.data.op,
            type: TransactionDbType.input
          }
        }),
        ...contractOutputs,
        ...(hiveMerkleProof.id ? [hiveMerkleProof] : [])
      ]
      
      const merkleRoot = simpleMerkleTree(txList.map(e => CID.parse(e.id).bytes))
      const sigRoot = simpleMerkleTree(offchainTxs.map(e => {
        const cid = CID.parse(e.sig_hash).bytes
        return cid;
      }))
      
      const prevBlock = await this.blockHeaders.findOne({
        
      }, {
        sort: {
          end_block: -1
        }
      })

      const blockFull = {
        __t: 'vsc-block',
        __v: '0.1',
        txs: txList,
        headers: {
          prevb: prevBlock ? prevBlock.id : null
        },
        
        merkle_root: merkleRoot ? merkleRoot : null,
        sig_root: sigRoot ? sigRoot : null
        // mmr_root: !merkleRoot && null
      }
      console.log('blockFull witness', blockFull, await this.self.ipfs.dag.put(blockFull))
      
      const blockContainer = new BlockContainer(blockFull);
      blockContainer.ref_start = start_height
      blockContainer.ref_end = end_height
      return blockContainer
    }

    async proposeBlock(block_height: number) {

      const lastHeader = await this.blockHeaders.findOne({
        
      }, {
        sort: {
          end_block: -1
        }
      })
      

      //If no other header is available. Use genesis day as range
      const start_height = lastHeader ? lastHeader.end_block + 1 : networks[this.self.config.get('network.id')].genesisDay

      const blockContainer = await this.createBlock({
        end_height: block_height,
        start_height: start_height
      })
      console.log('Stage 0 got blockContainer', {
        end_height: block_height,
        start_height: start_height
      }, blockContainer.toObject())

      if(blockContainer.rawData.txs.length === 0) {
        console.log("Cant produce blocks: 0 TXs")
        //Don't produce block if no TXs
        return;
      }

      const blockHeader = await blockContainer.toHeader()

      const encodedPayload = await encodePayload(blockHeader)

      console.log('Stage 1', {
        ...blockHeader,
        block: blockHeader.block.toString()
      })
      await sleep(4_000)
      const {drain} = await this.self.p2pService.memoryPoolChannel.call('propose_block', {
        payload: {
          block_header: {
            ...blockHeader,
            block: blockHeader.block.toString()
          },
          block_full: blockContainer.toObject(),
          block_height,
          hash: encodedPayload.cid.toString(),
        },
        mode: 'stream',
        streamTimeout: 15_000
      })
      const keys = await this.self.chainBridge.getWitnessesAtBlock(block_height)
      const blockHash = await this.self.ipfs.dag.put(blockHeader);
      console.log('BlsCircuit', blockHeader, blockHash)
      const circuit = new BlsCircuit({
        hash: blockHash.bytes
      })
      const keysMap = keys.map(e => {
        return e.keys.find(key => {
          return key.t === "consensus"
        })
      }).filter(e => !!e).map(e => e.key);

      const signedData = await this.self.consensusKey.signRaw(blockHash.bytes);
      console.log('signedData', signedData)
      console.log('Testing Sig verify', await circuit.verifySig({
        pub: JSON.parse(Buffer.from(signedData.p, 'base64url').toString()).pub,
        sig: signedData.s
      }))
      // console.log('Stage 2')
      // console.log('keysMap', keysMap.length, keys.map(e => e.account))
      // console.log('witness.sign', blockHeader)
      // console.log(keysMap)
      
      let voteMajority = 0.67
      for await(let sigMsg of drain) {
        const from = sigMsg.from
        const sig = sigMsg.payload?.s
        if(!sig) {
          continue;
        }
        try {
          const pub = JSON.parse(Buffer.from(sigMsg.payload.p, 'base64url').toString()).pub
          // console.log('INCOMING PUB SIG', pub, from)
          //Prevent rogue key attacks
          
          
          const verifiedSig = await circuit.verifySig({
            sig,
            pub,
          });
          // 'verified sig',
          if(verifiedSig) {
            if(!keysMap.includes(pub)) {
              console.log('KeysMap NOT included', pub)
              continue;
            }
            
            const result = await circuit.add({
              sig,
              did: pub,
            })
            
            
            // console.log('result', result)
            // console.log('aggregated DID', circuit.did.id)
            //Vote majority is over threshold.
            if(circuit.aggPubKeys.size === keysMap.length ) {
              //Stop filling circuit if over majority. Saving on unneeded extra bitvectors
              console.log('BLS circuit filled')
              break;
            }
          } else {
            if(from.toString() === '12D3KooWLxp3mk99i9QYt1wNzGzv1zLS1ZppofTkw3bEgz9FwvS4') {
              console.log("SIG not verified")
            }
          }
        } catch (ex) {
          console.log(ex)
        }
      }

      let blockSignature;
      try {
        blockSignature = circuit.serialize(keysMap)
      } catch {
        console.log('ERROR: block not signed')
        //Not signed
        return;
      }

      const signedBlock = {
        ...blockHeader,
        block: blockHeader.block.toString(),
        signature: blockSignature
      }
      // console.log(signedBlock, circuit.aggPubKeys.size, keysMap.length, {
      //   net_id: this.self.config.get('network.id'),
      //   signed_block: signedBlock
      // })
      // console.log('circuit aggregate', circuit.aggPubKeys)
      //Did it pass minimum?   
      if(circuit.aggPubKeys.size / keysMap.length > voteMajority){
        if(process.env.BLOCK_BROADCAST_ENABLED === "yes") {

          console.log('Broadcasting block live!')
          await this.self.ipfs.dag.put(blockContainer.toObject())
          await this.self.ipfs.dag.put(signedBlock)
          await HiveClient.broadcast.json({
            id: 'vsc.propose_block.experiment', 
            required_auths: [process.env.HIVE_ACCOUNT],
            required_posting_auths: [],
            json: JSON.stringify({
              //Prevents indexing of older experimental blocks.
              experiment_id: 2,
              net_id: this.self.config.get('network.id'),
              signed_block: signedBlock
            })
          }, PrivateKey.fromString(process.env.HIVE_ACCOUNT_ACTIVE))
        }
      }
    }

    async verifyBlock() {

    }

    async blockParser({data:block}) {
        const block_height = block.key;
        const schedule = await this.roundCheck(block_height) || []

        const scheduleSlot = schedule.find(e => e.bn === block_height)
        // console.log(this.self.chainBridge.parseLag, schedule, this.self.chainBridge.parseLag < 5)


        // await HiveClient.broadcast.json({
        //   id: 'vsc.propose_block.ignoretest', 
        //   required_auths: [process.env.HIVE_ACCOUNT],
        //   required_posting_auths: [],
        //   json: JSON.stringify({
        //     net_id: this.self.config.get('network.id'),
        //     signed_block: {
        //       "__t": "vsc-bh",
        //       "__v": "0.1",
        //       "headers": {
        //           "prevb": null,
        //           "br": [
        //               81614028,
        //               82204790
        //           ]
        //       },
        //       "merkle_root": null,
        //       "block": "bafyreibjdz7araqovreovmofe3rdfi3liviijow5hapb3eyu234fh4zpby",
        //       "signature": {
        //           "sig": "h1jNPb_JsLFJrtjeEIdWpDq98RffkYfT36iVgQL5myTatIiP0Thtw7EFQBtT_1TiFGlPdOxpNE9lZDQoKBySWmdHaRAx5VNBD3kRyk406ThE8snyKYwiVgjYmcFbS0HA",
        //           "bv": "AQ"
        //       }
        //   }
        //   })
        // }, PrivateKey.fromString(process.env.HIVE_ACCOUNT_ACTIVE))

        if(!!scheduleSlot &&  this.self.chainBridge.parseLag < 5) {
          // const lastHeader = await this.blockHeaders.findOne({
        
          // }, {
          //   sort: {
          //     hive_ref_block: -1
          //   }
          // })
          
    
          //If no other header is available. Use genesis day as range
          // const start_height = lastHeader ? lastHeader.end_block : networks[this.self.config.get('network.id')].genesisDay
    
          if(scheduleSlot.account === process.env.HIVE_ACCOUNT) {
            await this.proposeBlock(block_height)
          }
        }
    }

    async roundCheck(blockHeight) {
        if(this.witnessSchedule.valid_to > blockHeight && this.witnessSchedule.valid_from < blockHeight) {
          return this.witnessSchedule.schedule;
        }
        const {schedule, valid_to, valid_from} = await this.weightedSchedule(networks[this.self.config.get('network.id')].totalRounds, blockHeight)

        this.witnessSchedule.schedule = schedule
        this.witnessSchedule.valid_from = valid_from
        this.witnessSchedule.valid_to = valid_to

        return schedule
    }

    async handleProposeBlockMsg(pubReq) {
      const {message, drain, from} = pubReq;

      
      let cadBlock = this._candidateBlocks[message.block_height]
      if(!cadBlock) {
        for(let attempts = 0; attempts < 12; attempts++) {
          if(this._candidateBlocks[message.block_height]) {
            cadBlock = this._candidateBlocks[message.block_height]
            break;
          } else {
            await sleep(1_000)
          }
        }
      }
      // console.log('VERIFYING block over p2p channels', cadBlock, message.block_height, message)
      // console.log('VERIFYING', await this.self.chainBridge.getWitnessesAtBlock(Number(message.block_height)))
      const {block_header, block_full} = message;
      
      //Validate #0
      //Ensure everything is defined. Only relevent for outdated nodes
      if(!block_header || !block_full) {
        console.log('Witness.cadBlock validate #0 - missing block_header or block_full')
        return;
      }
      
      console.log(block_header, block_full)
      //Must be parsed as CID for hashing to work correctly when signing.
      block_header.block = CID.parse(block_header.block)
      
      //Validate #1
      //Verify witness is in runner

      const block_height = this.self.chainBridge.streamParser.stream.lastBlock
      const schedule = await this.roundCheck(block_height)

      const slotHeight = (block_height - (block_height % networks[this.self.config.get('network.id')].roundLength)) //+ networks[this.self.config.get('network.id')].roundLength
      
      const fromWitness = (await this.self.chainBridge.witnessDb.findOne({
        ipfs_peer_id: from.toString()
      }))
      console.log(fromWitness)
      const witnessSlot = schedule.find(e => {
          //Ensure witness slot is within slot start and end
          // console.log('slot check', e.bn === slotHeight && e.account === opPayload.required_auths[0])
          return e.bn === slotHeight && e.account === fromWitness.account
      })

      if(!witnessSlot) {
        console.log('Witness.cadBlock validate #1 - witness not in current slot')
        return;
      }

      //TODO: Add something here

      //Validate #2
      //Verify block_full is the same as block_header value

      const cid = await this.self.ipfs.dag.put(block_full, {
        onlyHash: true,
      })

      if(cid.toString() !== block_header.block.toString()) {
        console.log(`Witness.cadBlock validate #2 - invalid block_full hash expected: ${cid.toString()} got: ${block_header.block}`)
        return;
      }

      //Validate #3
      //Verify br (block range) is correct
      //Verify low value

      const topHeader = await this.blockHeaders.findOne({
        
      }, {
        sort: {
          end_block: -1
        }
      })

      if(topHeader) {
        if(block_header.headers.br[0] !== topHeader.end_block + 1) {
          console.log(block_header.headers.br[0], topHeader.end_block)
          console.log('Witness.cadBlock validate #3 - not matching topheader')
          return;
        }
      } else {
        if(block_header.headers.br[0] !== networks[this.self.config.get('network.id')].genesisDay) {
          console.log('Witness.cadBlock validate #3 - not matching genesis')
          return;
        }
      }


      //Validate #4
      //Verify merkle root

      let merkleRootTotal;
      if(block_full.txs.length === 0) {
        merkleRootTotal = null
      } else {
        merkleRootTotal = simpleMerkleTree(block_full.txs.map(e => CID.parse(e.id).bytes))
      }

      if(block_header.merkle_root !== merkleRootTotal) {
        console.log(`Witness.cadBlock validate #4 - block **header** incorrect merkle root expected: ${merkleRootTotal} got: ${block_header.merkle_root}`)
        return;
      }
      
      if(block_full.merkle_root !== merkleRootTotal) {
        console.log(`Witness.cadBlock validate #4 - block **full** incorrect merkle root expected: ${merkleRootTotal} got: ${block_full.merkle_root }`)
        return;
      }

      //Validate #5
      //Verify Hive merkle root
      
      //Validate #6
      //Validate offchain TX nonces

      //Use this later for verifying sort
      let vrfTxs = [

      ]

      //Note, offchain needs to be properly categorized as offchain and what is considered an input
      //Offchain can be more than just an input
      const offchainInputTxs = block_full.txs.filter(e => {
        return e.type === TransactionDbType.input
      })

      const nonceMap:Record<string, number> = {}
      for(let tx of offchainInputTxs) {
        const txRecord = await this.self.transactionPool.txDb.findOne({
          id: tx.id
        })
        if(!txRecord) {
          console.log('Witness.cadBlock validate #6 - tx not found in DB')
          return
        }
        const keyId = await computeKeyId(txRecord.required_auths.map(e => e.value))
        if(!nonceMap[keyId]) {
          const nonceRecord = await this.self.nonceMap.findOne({
            id: keyId
          })
          if(!nonceRecord) {
            //Assume zero nonce
            nonceMap[keyId] = 0;
          } else {
            nonceMap[keyId] = nonceRecord.nonce
          }
        }
        console.log('nonce', keyId, nonceMap[keyId], txRecord.headers.nonce)
        if(nonceMap[keyId] !== txRecord.headers.nonce) {
          console.log(`Witness.cadBlock validate #6 - invalid nonce for keyId: ${keyId}`)
          return
        }
        nonceMap[keyId] = nonceMap[keyId] + 1;
        
        vrfTxs.push({
          id: tx.id,
          nonce: txRecord.headers.nonce,    
          act: keyId,
          sig_hash: txRecord.sig_hash
        })
      }
      

      //Validate #7
      //Validate total sorting
      
      console.log(block_header.headers.br[0])
      const blockKey = await this.self.chainBridge.events.findOne({
        key: block_header.headers.br[0]
      })
      let seed = blockKey.block_id
      
      const sortedTxs = sortTransactions(offchainInputTxs, seed)

      for(let index in sortedTxs) {
        //Verify sorting
        if(offchainInputTxs[index].id !== sortedTxs[index].id) {
          console.log(`Witness.cadBlock validate #7 - invalid sorting at index: ${index} expected: ${sortedTxs[index].id} got ${offchainInputTxs[index].id}`)
          return;
        }
      }
      
      //Validate #8
      //Segwit root
      let segwitRoot
      if(vrfTxs.length === 0) {
        segwitRoot = null
      } else {
        segwitRoot = simpleMerkleTree(vrfTxs.map(e => CID.parse(e.sig_hash).bytes))
      }

      if(block_full.sig_root !== segwitRoot) {
        console.log(`Witness.cadBlock Validate #8 - invalid sig root expected: ${segwitRoot} got: ${block_full.sig_root}`)
        return;
      }
      

      //Validate #9
      //Validate Offchain TX validity

      //Validate #10
      //Validate contract outputs

      //Validate #11
      //Validate other core operations
      //Contract broadcast confirm

      
      



      console.log('block_header - before sign', block_header, await this.self.ipfs.dag.put(block_header))
      const signData = await this.self.consensusKey.signRaw((await this.self.ipfs.dag.put(block_header, {
        onlyHash: true
      })).bytes)
      drain.push(signData)

      if(cadBlock) {
        // delete cadBlock.block
        // cadBlock.block = CID.parse(cadBlock.block.toString())
        // console.log('cadBlock.signRaw', cadBlock, (await encodePayload(cadBlock)).cid, await this.self.ipfs.block.put(IPLDDag.util.serialize(cadBlock), {
        //   format: 'dag-cbor'
        // }), await this.self.ipfs.dag.put(cadBlock), await this.self.ipfs.dag.put({
        //   testLink: CID.parse(cadBlock.block.toString())
        // }))
        
        
      }
      // const cid = CID.parse(message.hash)
      // const signData = await this.self.consensusKey.signRaw(cid.bytes)
      // console.log(signData)

      // drain.push(signData)
    }

    async init() {
      this.blockHeaders = this.self.db.collection('block_headers')

      // this.self.chainBridge.registerTickHandle('witness.blockTick', this.blockTick, {
      //   type: 'block',
      //   priority: 'after'
      // }),
      this.self.chainBridge.streamParser.addParser({
        name: 'witness',
        type: 'block',
        //Must be after 
        priority: 'after',
        func: this.blockParser
      })

      this.self.p2pService.memoryPoolChannel.register('propose_block', this.handleProposeBlockMsg, {
        loopbackOk: true
      })
    }

    async start() {

      await this.delayMonitor.start();
    }
}