import { MerkleTree } from 'merkletreejs'
import SHA256 from 'crypto-js/sha256'
import { encodePayload } from 'dag-jose-utils'
import networks from "../../../services/networks";
import { NewCoreService } from "..";
import { HiveClient } from "../../../utils";
import { CID } from 'kubo-rpc-client';
import { BlsCircuit, BlsDID } from '../utils/crypto/bls-did';
import { Collection } from 'mongodb';
import { BlockHeader } from '../types';
import { PrivateKey } from '@hiveio/dhive';


export class BlockContainer {
    rawData: any;
    ref_start: number;
    ref_end: number
    constructor(rawData) {
      this.rawData = rawData
    }

    async toHeader() {
      
      const block = await encodePayload(this.rawData)
      
      return {
        __t: "vsc-bh",
        __v: '0.1',
        headers: {
          //Find previous block here
          prevB: '',
          //block range
          br: [this.ref_start, this.ref_end]
        },
        merkle_root: this.rawData.merkle_root,
        block: block.cid
      }
    }

    static fromObject(rawData): BlockContainer {
      return new BlockContainer(rawData)
    }
}

function simpleMerkleTree(tree: string[]) {
  const leaves = tree.map(x => SHA256(x))
  const merkleTree = new MerkleTree(leaves, SHA256)
  console.log(merkleTree.getRoot().length)
  const root = merkleTree.getRoot().toString('base64url')
  return root
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

    constructor(self: NewCoreService) {
        this.self = self;

        this.blockTick = this.blockTick.bind(this)
        this.handleProposeBlockMsg = this.handleProposeBlockMsg.bind(this)

        this.witnessSchedule = {
            valid_to: null
        }
        this._candidateBlocks = {

        }
    }



    async weightedSchedule(totalRounds, blockHeight: number) {
        const consensusRound = await this.calculateConsensusRound(blockHeight)
        const witnessNodes = await this.self.chainBridge.getWitnessesAtBlock(blockHeight)
        
        let outSchedule = []
        for (let x = 0; x < totalRounds; x++) {
          if (witnessNodes[x % witnessNodes.length]) {
            outSchedule.push(witnessNodes[x % witnessNodes.length])
          }
        }
    
        outSchedule = await this.applyBNSchedule(outSchedule, blockHeight)

        return {
            schedule: outSchedule,
            valid_from: outSchedule[0].bn,
            valid_to: outSchedule[outSchedule.length - 1].bn
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

    
    async createBlock(args: {
      block_height: number
      start_height: number
    }): Promise<BlockContainer> {
      const {block_height, start_height} = args;
      const transactions = await this.self.transactionPool.txDb.find({
        'headers.anchored_height': {
          $lte: block_height,
          $gte: start_height
        },
        $or: [
          {
            //Make sure transactions are locked in the future
            'headers.lock_block': {
              $gt: block_height
            }
          }, {
            'headers.lock_block': {
              $exists: false
            }
          }
        ]
      }).toArray()

      const offchainTxs = transactions.filter(e => {
        return e.src === 'vsc'
      })

      const onchainTxs = transactions.filter(e => {
        return e.src === 'hive'
      })

      const totalTxIDs = [
        ...transactions.map(e => e.id)
      ]
      
      // const root = simpleMerkleTree(txIds)
      
      let hiveMerkleProof = {
        id: null,
        data: null,
        chain: 'hive',
        type: "anchor_proof"
      }
      if(onchainTxs.length > 0) {
        const txIds = onchainTxs.map(e => e.id);
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

      const contractIds = await this.self.transactionPool.txDb.distinct('headers.contract_id', {
        $or: [
          {
            'headers.lock_block': {
              $gt: block_height
            }
          }, {
            'headers.lock_block': {
              $exists: false
            }
          }
        ]
      })

      const contractTxs = onchainTxs.filter(e => {
        return e.data.op === "call_contract"
      })

      console.log(contractTxs)
      console.log('contractIds', contractIds)
      let contractOutputs = []
      for(let contractId of contractIds) {
        const output = await this.self.contractEngine.createContractOutput({
          txs: contractTxs,
          contract_id: contractId
        })
        
        //Store unsigned outputs for now.
        const outputCid = await this.self.ipfs.dag.put(output)

        contractOutputs.push({
          id: outputCid,
          type: "contract_output"
        })
      }

      const txList = [
        ...contractOutputs,
        ...(hiveMerkleProof.id ? [hiveMerkleProof] : [])
      ]
      
      const merkleRoot = simpleMerkleTree(txList.map(e => e.id))
      

      const blockFull = {
        __t: 'vsc-block',
        __v: '0.1',
        txs: txList,
        // contract_index: {
        //   'null': []
        // },
        merkle_root: !merkleRoot && null
      }
      console.log('blockFull', blockFull)
      const blockContainer = new BlockContainer(blockFull);
      blockContainer.ref_start = block_height
      blockContainer.ref_end =  block_height + 20
      return blockContainer
    }

    async proposeBlock(block_height: number) {

      const lastHeader = await this.blockHeaders.findOne({
        
      }, {
        sort: {
          hive_ref_block: -1
        }
      })
      

      //If no other header is available. Use genesis day as range
      const start_height = lastHeader ? lastHeader.hive_ref_block : networks[this.self.config.get('network.id')].genesisDay

      const blockFull = await this.createBlock({
        block_height,
        start_height: start_height
      })

      const blockHeader = await blockFull.toHeader()

      console.log('PROPOSING BLOCKFULL', blockFull)
      const sigPacked = await this.self.consensusKey.signObject(blockFull)
      console.log('sigPacked', sigPacked)

      const encodedPayload = await encodePayload(blockHeader)


      console.log('proposing block over p2p channels', blockHeader)
      const {drain} = await this.self.p2pService.memoryPoolChannel.call('propose_block', {
        payload: {
          block_height,
          hash: encodedPayload.cid.toString(),
        },
        mode: 'stream',
        streamTimeout: 12_000
      })
      const keys = await this.self.chainBridge.getWitnessesAtBlock(block_height)
      const circuit = new BlsCircuit(blockHeader)
      const keysMap = keys.map(e => {
        return e.keys.find(key => {
          console.log(key)
          return key.t === "consensus"
        })
      }).filter(e => !!e).map(e => e.key);
      console.log('keysMap', keysMap)

      let voteMajority = 0.67
      for await(let sigMsg of drain) {
        const pub = JSON.parse(Buffer.from(sigMsg.payload.p, 'base64url').toString()).pub
        console.log('INCOMING PUB SIG', pub)
        //Prevent rogue key attacks
        if(!keysMap.includes(pub)) {
          continue;
        }
        const sig = sigMsg.payload.s
        const verifiedSig = await circuit.verifySig({
          sig,
          pub,
        });
        // 'verified sig',
        console.log(verifiedSig)
        if(verifiedSig) {
          console.log({
            sig,
            did: pub,
          })
          const result = await circuit.add({
            sig,
            did: pub,
          })


          //Vote majority is over threshold.
          if(circuit.aggPubKeys.size / keysMap.length > voteMajority ) {
            //Stop filling circuit if over majority. Saving on unneeded extra bitvectors
            break;
          }
          console.log('result', result)
          console.log('aggregated DID', circuit.did.id)
        }
      }

      
      if(circuit.aggPubKeys.size / keysMap.length > voteMajority){
        const signedBlock = {
          ...blockHeader,
          block: blockHeader.block.toString(),
          signature: circuit.serialize(keysMap)
        }
        await HiveClient.broadcast.json({
          id: 'vsc.propose_block.ignoretest', 
          required_auths: [process.env.HIVE_ACCOUNT],
          required_posting_auths: [],
          json: JSON.stringify({
            net_id: this.self.config.get('network.id'),
            signed_block: signedBlock
          })
        }, PrivateKey.fromString(process.env.HIVE_ACCOUNT_ACTIVE))

      }
    }

    async verifyBlock() {

    }

    async blockTick(block) {
        const block_height = block.key;
        console.log('block_height', block_height)
        const schedule = await this.roundCheck(block_height) || []

        const scheduleSlot = schedule.find(e => e.bn === block_height)
        if(!!scheduleSlot &&  this.self.chainBridge.stream.blockLag < 3) {
          const lastHeader = await this.blockHeaders.findOne({
        
          }, {
            sort: {
              hive_ref_block: -1
            }
          })
          
    
          //If no other header is available. Use genesis day as range
          const start_height = lastHeader ? lastHeader.hive_ref_block : networks[this.self.config.get('network.id')].genesisDay
    
          const blockFull = await this.createBlock({
            start_height,
            block_height: block_height,
          })
          this._candidateBlocks[block_height] = await blockFull.toHeader()
          console.log('SAVING CANDIDATE BLOCK', this._candidateBlocks[block_height])
          if(scheduleSlot.account === process.env.HIVE_ACCOUNT) {
            console.log('I can actually produce a block!')
            await this.proposeBlock(block_height)
          }
        }
    }

    async roundCheck(blockHeight) {
        if(this.witnessSchedule.valid_to > blockHeight) {
            return this.witnessSchedule.schedule;
        }
        const {schedule, valid_to, valid_from} = await this.weightedSchedule(networks[this.self.config.get('network.id')].totalRounds, blockHeight)

        this.witnessSchedule.schedule = schedule
        this.witnessSchedule.valid_from = valid_from
        this.witnessSchedule.valid_to = valid_to

        return schedule
    }

    async handleProposeBlockMsg(pubReq) {
      const {message, drain} = pubReq;

      
      const cadBlock = this._candidateBlocks[message.block_height]
      console.log('VERIFYING block over p2p channels', cadBlock, message.block_height, message)
      if(cadBlock) {
        const signData = await this.self.consensusKey.signRaw((await encodePayload(cadBlock)).cid.bytes)
        console.log(signData)
        
        drain.push(signData)
      }
      // const cid = CID.parse(message.hash)
      // const signData = await this.self.consensusKey.signRaw(cid.bytes)
      // console.log(signData)

      // drain.push(signData)
    }

    async init() {
      this.blockHeaders = this.self.db.collection('block_headers')

      this.self.chainBridge.registerTickHandle('witness.blockTick', this.blockTick, {
        type: 'block'
      })

      this.self.p2pService.memoryPoolChannel.register('propose_block', this.handleProposeBlockMsg, {
        loopbackOk: true
      })
    }

    async start() {

    }
}