
import { encodePayload } from 'dag-jose-utils'
import networks from "../../../services/networks";
import { NewCoreService } from "..";
import { HiveClient, sleep } from "../../../utils";
import { BlsCircuit, BlsDID } from '../utils/crypto/bls-did';
import { Collection, WithId } from 'mongodb';
import { CID } from 'multiformats';
import IPLDDag from 'ipld-dag-cbor'
import ShuffleSeed from 'shuffle-seed'
import fs from 'fs/promises'


import { BlockHeader, BlockHeaderDbRecord, TransactionDbRecordV2, TransactionDbStatus, TransactionDbType } from '../types';
import { PrivateKey } from '@hiveio/dhive';
import { DelayMonitor } from './delayMonitor';
import { simpleMerkleTree } from '../utils/crypto';
import { ParserFuncArgs, computeKeyId, sortTransactions } from '../utils';
import { MultisigSystem } from './multisig';
import { BalanceKeeper } from './balanceKeeper';

import telemetry from '../../../telemetry';
import { Schedule, getBlockSchedule } from './schedule';
import { MessageHandleOpts } from '../p2pService';
import { ExecuteStopMessage } from '../vm/types';
import { ContractErrorType } from '../vm/utils';

import {z} from 'zod'
import { SlotTracker } from './slotTracker';

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
        type: TransactionDbType
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
    witnessSchedule?: {
        valid_height: number
        valid_epoch: number
        schedule: Schedule
    }

    //VSC block headres ref
    blockHeaders: Collection<BlockHeaderDbRecord>
    delayMonitor: DelayMonitor;
    multisig: MultisigSystem;
    balanceKeeper: BalanceKeeper;
    slotTracker: SlotTracker;

    constructor(self: NewCoreService) {
        this.self = self;
        

        this.delayMonitor = new DelayMonitor(this.self, this)
        this.multisig = new MultisigSystem(this.self, this)
        this.balanceKeeper = new BalanceKeeper(this.self)
        this.slotTracker = new SlotTracker(self, this);

        this.blockParser = this.blockParser.bind(this)
        this.handleProposeBlockMsg = this.handleProposeBlockMsg.bind(this)
    }

    
    async createBlock(args: {
      start_height: number
      end_height: number
      offchainTxsUnfiltered?: TransactionDbRecordV2[]
    }): Promise<BlockContainer> {
      const {end_height, start_height} = args;
      // console.log('Gettting transactions query', {
      //   status: TransactionDbStatus.included,
      //   'anchored_height': {
      //     $lte: end_height,
      //     $gte: start_height - 1 //Account for calculated anchored_height. Note: revise this in the future.
      //   },
      //   $or: [
      //     {
      //       //Make sure transactions are locked in the future
      //       'headers.lock_block': {
      //         $gt: start_height
      //       }
      //     }, {
      //       'headers.lock_block': {
      //         $exists: false
      //       }
      //     }
      //   ]
      // })
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
        sort: [
          ['anchored_height', 1],
          ['anchored_index', 1],
          ['anchored_op_index', 1],
        ]
      }).toArray()
      // console.log('TO EXECUTE', transactions)

      const offchainTxsUnfiltered = args.offchainTxsUnfiltered || await this.self.transactionPool.txDb.find({
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
        },
        limit: 2048
      }).toArray()

      const nonceMap:Record<string, number> = {}
      const offchainTxs: TransactionDbRecordV2[] = []
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

     
      
      const hiveMerkleProof: {
        id: string
        data: string
        chain: string
        type: TransactionDbType
      } | null = await (async () => {
        if (onchainTxs.length === 0) {
          return null;
        }

        const txIds = onchainTxs.map(e => Buffer.from(e.id, 'hex'));
        const root = simpleMerkleTree(txIds)
        // console.log(root)
        // const proof = tree.getProof(SHA256(txIds[0]))
        // console.log(proof)
        // console.log('onchainTxs', onchainTxs.map(e => e.id))
        const id = (await this.self.ipfs.dag.put({
          txs: txIds
        })).toString()
        return {
          id,
          data: root,
          chain: 'hive',
          type: TransactionDbType.anchor_ref,
        }
      })();

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

      // console.log(contractIds)

      let contractOutputs: {
        id: string,
        contract_id: string,
        type: TransactionDbType,
      }[] = []
      if(transactions.length > 0 && contractIds.length > 0) {
        
        console.log('contractIds', contractIds)
        const vmContext = this.self.contractEngine.vmContext(contractIds);
        await vmContext.init()
        console.log('initalized vm')
        
        let results: Record<string, Array<{id: string; result: Omit<ExecuteStopMessage, 'type' | 'reqId'>}>> = {

        }
  
        for(let tx of transactions) {
          if(tx.data.contract_id) {
            const contract_id = tx.data.contract_id
            console.log('processing tx', JSON.stringify(tx, null, 2))
            const contractCallResult = await vmContext.processTx(tx)
            console.log('completed tx', JSON.stringify(contractCallResult, null, 2))
            if(!results[contract_id]) {
              results[contract_id] = []
            }
            if (contractCallResult.type === 'timeout') {
              results[contract_id].push({
                id: tx.id,
                result: {
                  ret: null,
                  error: 'timeout',
                  errorType: ContractErrorType.TIMEOUT,
                  logs: [],
                  IOGas: 0, // TODO prob shouldn't be 0
                }
              })
            } else {
              const {reqId, type, ...result} = contractCallResult;
              results[contract_id].push({
                id: tx.id,
                result,
              })
            }
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
        ...(hiveMerkleProof ? [hiveMerkleProof] : [])
      ]
      
      const merkleRoot = simpleMerkleTree(txList.map(e => CID.parse(e.id).bytes))
      const sigRoot = simpleMerkleTree(offchainTxs.map(e => {
        const cid = CID.parse(e.sig_hash).bytes // TODO check what is going on with sig_hash being maybe undefined
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
      // console.log('blockFull witness', blockFull, await this.self.ipfs.dag.put(blockFull))
      
      const blockContainer = new BlockContainer(blockFull);
      blockContainer.ref_start = start_height
      blockContainer.ref_end = end_height
      return blockContainer
    }

    async proposeBlock(block_height: number) {
      const proposalCtx = telemetry.captureTracedEvent(`proposal ${block_height}`, {
        block_height,
        latest_block: this.self.chainBridge.streamParser.stream.lastBlock,
        proposer: process.env.HIVE_ACCOUNT,
      })

      const lastHeader = await this.blockHeaders.findOne({
        
      }, {
        sort: {
          end_block: -1
        }
      })
      

      //If no other header is available. Use genesis day as range
      const start_height = lastHeader ? lastHeader.end_block + 1 : networks[this.self.config.get('network.id')].genesisDay

      const creatingBlockCtx = telemetry.continueTracedEvent(`creating block ${block_height}`, proposalCtx.traceInfo, {
        block_height,
        latest_block: this.self.chainBridge.streamParser.stream.lastBlock,
        proposer: process.env.HIVE_ACCOUNT,
      })
      const blockContainer = await this.createBlock({
        end_height: block_height,
        start_height: start_height
      })
      console.log('Stage 0 got blockContainer', {
        end_height: block_height,
        start_height: start_height
      })
      creatingBlockCtx.finish()

      if(blockContainer.rawData.txs.length === 0) {
        console.log("Cant produce blocks: 0 TXs")
        proposalCtx.finish()
        //Don't produce block if no TXs
        return;
      }

      const blockEncoderCtx = telemetry.continueTracedEvent(`block header encoding ${block_height}`, proposalCtx.traceInfo, {
        block_height,
        latest_block: this.self.chainBridge.streamParser.stream.lastBlock,
        proposer: process.env.HIVE_ACCOUNT,
      })

      const blockHeader = await blockContainer.toHeader()

      const encodedPayload = await encodePayload(blockHeader)

      console.log('Stage 1', {
        ...blockHeader,
        block: blockHeader.block.toString()
      })
      blockEncoderCtx.finish()

      // This shouldn't be here send the block ASAP
      // await sleep(4_000)

      const p2pCtx = telemetry.continueTracedEvent(`transmitting block ${block_height}`, proposalCtx.traceInfo, {
        block_height,
        latest_block: this.self.chainBridge.streamParser.stream.lastBlock,
        proposer: process.env.HIVE_ACCOUNT,
      })

      const {drain} = await this.self.p2pService.multicastChannel.call('propose_block', {
        payload: {
          slotHeight: block_height,
          txIds: blockContainer.rawData.txs.filter(({type}) => type === TransactionDbType.input).map(({id}) => id),
          traceInfo: proposalCtx.traceInfo,
        },
        responseOrigin: 'many',
        mode: 'stream',
        streamTimeout: 15_000
      })

      p2pCtx.finish()

      const pinningCtx = telemetry.continueTracedEvent(`pinning & signing ${block_height}`, proposalCtx.traceInfo, {
        block_height,
        latest_block: this.self.chainBridge.streamParser.stream.lastBlock,
        proposer: process.env.HIVE_ACCOUNT,
      })

      const blockHash = await this.self.ipfs.dag.put(blockHeader);
      console.log('BlsCircuit', blockHeader, blockHash)
      const circuit = new BlsCircuit({
        hash: blockHash.bytes
      })
      const membersOfBlock = (await this.self.electionManager.getMembersOfBlock(block_height))
      const keysMap = membersOfBlock.map(e => e.key)

      const signedData = await this.self.consensusKey.signRaw(blockHash.bytes);
      console.log('signedData', signedData)
      console.log('Testing Sig verify', await circuit.verifySig({
        pub: JSON.parse(Buffer.from(signedData.p, 'base64url').toString()).pub,
        sig: signedData.s
      }))


      //Aggregate self signature
      await circuit.add({
        sig: signedData.s,
        did: JSON.parse(Buffer.from(signedData.p, 'base64url').toString()).pub
      })

      pinningCtx.finish()
      // console.log('Stage 2')
      // console.log('keysMap', keysMap.length, keys.map(e => e.account))
      // console.log('witness.sign', blockHeader)
      // console.log(keysMap)
      
      let revcCtx = telemetry.continueTracedEvent(`waiting for signatures ${block_height}`, proposalCtx.traceInfo, {
        block_height,
        latest_block: this.self.chainBridge.streamParser.stream.lastBlock,
        proposer: process.env.HIVE_ACCOUNT,
      })

      let voteMajority = 0.67
      const iter = drain[Symbol.asyncIterator]()
      // for await(let sigMsg of drain) {
      while (true) {
        revcCtx.finish()
        const {done, value: sigMsg} = await iter.next()
        if (done) {
          break
        }

        revcCtx = telemetry.continueTracedEvent(`received signature ${block_height}`, proposalCtx.traceInfo, {
          block_height,
          latest_block: this.self.chainBridge.streamParser.stream.lastBlock,
          proposer: process.env.HIVE_ACCOUNT,
          from: sigMsg.from?.toString(),
          ...(sigMsg.payload ?? {})
        })

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

          revcCtx.addMetadata({verifiedSig})

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

            revcCtx.addMetadata({
              aggPubKeysSize: circuit.aggPubKeys.size,
              keysMapLength: keysMap.length,
            })

            const signerNode = membersOfBlock.find(e => e.key === pub)
            console.log('signerNode', signerNode, pub)
            
            // console.log('result', pub)
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

      revcCtx.finish()

      let blockSignature;
      try {
        blockSignature = circuit.serialize(keysMap)
      } catch {
        console.log('ERROR: block not signed')
        proposalCtx.finish()
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


      const lastElection = await this.self.electionManager.getValidElectionOfblock(block_height)

      let votedWeight = 0;
      let totalWeight = lastElection.weight_total
      for(let member of circuit.aggPubKeys.keys()) { 
        const memberNode = lastElection.members.find(e => e.key === member);
        if (!memberNode) {
          continue
        }
        votedWeight += lastElection.weights[lastElection.members.indexOf(memberNode)]
      }


      console.log('votedWeight', votedWeight, 'requiredWeight', totalWeight * voteMajority , 'totalWeight', totalWeight)

      //Did it pass minimum?   
      let error: any
      let thrown = false
      try {
        console.log(circuit.aggPubKeys.size, keysMap.length, keysMap.length * voteMajority)
        if(votedWeight / totalWeight > voteMajority) {
          //Disable block broadcast if required by local configuration
          if(process.env.BLOCK_BROADCAST_DISABLED !== "yes") {

            console.log('Broadcasting block live!')
            await this.self.ipfs.dag.put(blockContainer.toObject())
            await this.self.ipfs.dag.put(signedBlock)
            await HiveClient.broadcast.json({
              id: 'vsc.propose_block', 
              required_auths: [process.env.HIVE_ACCOUNT],
              required_posting_auths: [],
              json: JSON.stringify({
                //Prevents indexing of older experimental blocks.
                replay_id: 2,
                net_id: this.self.config.get('network.id'),
                signed_block: signedBlock
              })
            }, PrivateKey.fromString(process.env.HIVE_ACCOUNT_ACTIVE))
          }
        }
      } catch (e) {
        thrown = true
        error = e
      }
      proposalCtx.finish()
      if (thrown) {
        throw error
      }
    }

    async verifyBlock() {

    }

    async getWitnessActiveScore(block_height: number) {
      const blockCount = 60
      // const targetConstraints = {
      //   // low: 7/10,
      //   // high: 9/10
      // }
      const targetConstraints = [
        [0, 6],
        [0.70, 10],
        [0.8, 13]
      ] as const
      
      const lastXBlocks = await this.blockHeaders.find({
        slot_height: {
          $lte: block_height
        }
      }, {
        sort: {
          slot_height: -1
        },
        limit: blockCount
      }).toArray()
      
      const expectedBlockScore: Record<string, number> = { 
        
      }
      
      const scoreMap: Record<string, number> = {
        
      }
      
      
      for(let block of lastXBlocks) {
        const {slot_height, signers} = block 
        const election = await this.self.electionManager.getValidElectionOfblock(slot_height)
  
        const memberSet = election.members.map(e => e.account)
        for(let member of memberSet) {
          if(!scoreMap[member]) {
            scoreMap[member] = 0
          }
          if(!expectedBlockScore[member]) {
            expectedBlockScore[member] = 0
          }
          expectedBlockScore[member] = expectedBlockScore[member] + 1
        }
        
        for(let account of signers) {
          if(!scoreMap[account]) {
            scoreMap[account] = 0
          }
          scoreMap[account] = scoreMap[account] + 1
        }
      }

      let out = {}
      for(let [key, value] of Object.entries(scoreMap)) {
        const pctRaw = (value / expectedBlockScore[key])


        let weight;
        for(let tc of targetConstraints) {
          const [t, w] = tc
          if(pctRaw >= t) {
            weight = w;
          }
        }
        

        out[key] = {
          account: key,
          pct: Math.round(pctRaw * 100),
          expected: expectedBlockScore[key],
          actual: value,
          weight
        }
      }
     
      return out
    }

    async blockParser({data:block}: ParserFuncArgs<'block'>) {
        const block_height = block.key;

        //Do parseLag before all other checks to prevent using unnecessary CPU when fetching blockSchedule.
        if(this.self.chainBridge.parseLag < 5) {
          const schedule = await this.getBlockSchedule(+block_height) || []
    
          const scheduleSlot = schedule.find(e => e.bn === +block_height)
    
          if(!!scheduleSlot) {
      
            //If no other header is available. Use genesis day as range
            // const start_height = lastHeader ? lastHeader.end_block : networks[this.self.config.get('network.id')].genesisDay
      
            if(scheduleSlot.account === process.env.HIVE_ACCOUNT) {
              this.slotTracker.lastValidSlot = +block_height;
              await this.proposeBlock(+block_height)
            }
          }
        }
      }

    /**
     * Get block producer schedule
     * @param blockHeight 
     * @returns 
     */
    getBlockSchedule(blockHeight: number) {
      return getBlockSchedule(this, blockHeight)
    }

    async handleProposeBlockMsg(pubReq: MessageHandleOpts) {
      const {message, drain, from} = pubReq;

      const block_height = this.self.chainBridge.streamParser.stream.headHeight;
      const roundLength = networks[this.self.config.get('network.id') as keyof typeof networks].roundLength;
      const slotHeight = message?.slotHeight || (block_height - (block_height % roundLength));

      let recvCtx: ReturnType<typeof telemetry['continueTracedEvent']> | null = null
      if (message?.traceInfo) {
        recvCtx = telemetry.continueTracedEvent(`received block proposal ${slotHeight}`, message.traceInfo, {
          block_height: slotHeight,
          latest_block: block_height,
          from: from?.toString(),
        })
      }

      if (slotHeight !== (slotHeight - (slotHeight % networks[this.self.config.get('network.id')].roundLength))) {
        console.log('invalid slotHeight', JSON.stringify({slotHeight, from: from?.toString()}, null, 2));
        return;
      }

      if (slotHeight > block_height + roundLength - 1) {
        console.log('invalid slotHeight future', JSON.stringify({slotHeight, block_height, from: from?.toString()}, null, 2));
        return;
      }

      if (slotHeight < block_height - roundLength + 1) {
        console.log('invalid slotHeight too old', JSON.stringify({slotHeight, block_height, from: from?.toString()}, null, 2));
        return;
      }

      let updateCtx: ReturnType<typeof telemetry['continueTracedEvent']> | null = null
      if (message?.traceInfo) {
        updateCtx = telemetry.continueTracedEvent(`waiting for node to be up to date ${slotHeight}`, message.traceInfo, {
          block_height: slotHeight,
          latest_block: block_height,
          from: from?.toString(),
        })
      }
      
      //This doesn't help IF node is slightly behind the requester node as slotHeight is calcuated from the local block data rather than what's being requested at the block level
      //This should always pass unless there is a tiny amount of lag in the parsing section of the code
      for(let attempts = 0; attempts < 12 && this.self.chainBridge.streamParser.lastParsed < slotHeight; attempts++) {
        await sleep(1_000)
      }

      

      updateCtx?.finish()
      
      if (this.self.chainBridge.streamParser.lastParsed < slotHeight) {
        recvCtx?.finish()
        return
      }

      let verifyingCtx: ReturnType<typeof telemetry['continueTracedEvent']> | null = null
      if (message?.traceInfo) {
        verifyingCtx = telemetry.continueTracedEvent(`verifying block proposal ${slotHeight}`, message.traceInfo, {
          block_height: slotHeight,
          latest_block: block_height,
          from: from?.toString(),
        })
      }

      const DONE_ERROR = new Error('done')

      try {
        // console.log('VERIFYING block over p2p channels', cadBlock, message.block_height, message)
        // console.log('VERIFYING', await this.self.chainBridge.getWitnessesAtBlock(Number(message.block_height)))

        const {block_full, txIds} = message as {block_full: unknown; txIds: unknown};
        
        //Validate #1
        //Verify witness is in runner

        const schedule = await this.getBlockSchedule(slotHeight)

        // console.log('schedule info:', JSON.stringify({block_height, slotHeight, scheduled: schedule.find(slot => slot.bn === slotHeight)}, null, 2))

        
        const fromWitness = (await this.self.chainBridge.witnessDb.findOne({
          ipfs_peer_id: from.toString()
        }))

        if(!fromWitness) {
          console.log('Witness.cadBlock validate #1.1 - witness NOT FOUND in DB')
          throw DONE_ERROR;
        }

        const witnessSlot = schedule.find(e => {
            //Ensure witness slot is within slot start and end
            // console.log('slot check', e.bn === slotHeight && e.account === opPayload.required_auths[0])
            return e.bn === slotHeight && e.account === fromWitness.account
        })

        verifyingCtx?.addMetadata({proposer: fromWitness.account})

        
        if(!witnessSlot) {
          console.log(`Witness.cadBlock validate #1.3 - witness in wrong slot (@${fromWitness.account})`)
          throw DONE_ERROR;
        }

        this.slotTracker.lastValidSlot = slotHeight;

        const lastHeader = await this.blockHeaders.findOne({
        
      }, {
        sort: {
          end_block: -1
        }
      })
      

      //If no other header is available. Use genesis day as range
      const start_height = lastHeader ? lastHeader.end_block + 1 : networks[this.self.config.get('network.id')].genesisDay

        const end_height = slotHeight;

        const blockFullSchema = z.object({
          txs: z.array(
            z.intersection(
              z.object({
                type: z.literal(TransactionDbType.input),
                id: z.string()
              }),
              z.object({
                type: z.nativeEnum(TransactionDbType)
              }),
            ),
          ),
        });

        const txIdsSchema = z.array(z.string());

        const blockFullParseRes = blockFullSchema.safeParse(block_full)
        const txIdsParseRes = txIdsSchema.safeParse(txIds);

        const txs = (() => {
          if (txIdsParseRes.success) {
            return txIdsParseRes.data
          }
          
          if (blockFullParseRes.success) {
            return blockFullParseRes.data.txs
              .filter((v): v is typeof v & {type: TransactionDbType.input} => v.type === TransactionDbType.input)
              .map(({id}) => id as string);
          }

          console.log('missing tx id info')
          throw DONE_ERROR
        })()

        const offchainTxsUnChecked = await Promise.all(
          txs.map(id => this.self.transactionPool.txDb.findOne({id, status: TransactionDbStatus.unconfirmed}))
        );

        const offchainTxsUnfiltered = offchainTxsUnChecked.filter((tx, i): tx is WithId<TransactionDbRecordV2> => {
          if (!tx) {
            console.log('could not find tx with id:', txs[i]);
            return false
          }
          return true
        });

        if (offchainTxsUnChecked.length !== offchainTxsUnfiltered.length) {
          // error logs handled above
          throw DONE_ERROR
        }

        const block = await this.createBlock({start_height, end_height, offchainTxsUnfiltered});

        if (block.rawData.txs.length === 0) {
          throw DONE_ERROR
        }

        const blockHeader = await block.toHeader();

        // console.log('blockHeader - before sign', blockHeader, await this.self.ipfs.dag.put(blockHeader))
        const signData = await this.self.consensusKey.signRaw((await this.self.ipfs.dag.put(blockHeader, {
          pin: true
        })).bytes)
        drain.push(signData)
        await this.self.ipfs.dag.put(block, {
          pin: true
        })

      } catch (e) {
        if (e !== DONE_ERROR) {
          throw e
        }
      } finally {
        verifyingCtx?.finish()
        recvCtx?.finish()
      }
    }

    async init() {
      this.blockHeaders = this.self.db.collection('block_headers')
      await this.multisig.init()
      await this.balanceKeeper.init()
      await this.slotTracker.init()

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

      this.self.p2pService.multicastChannel.register('propose_block', this.handleProposeBlockMsg, {
        loopbackOk: true
      })
    }

    async start() {

      await this.delayMonitor.start();
    }
}