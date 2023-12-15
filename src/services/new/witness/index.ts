import { MerkleTree } from 'merkletreejs'
import SHA256 from 'crypto-js/sha256'
import { encodePayload } from 'dag-jose-utils'
import networks from "../../../services/networks";
import { NewCoreService } from "..";
import { HiveClient } from "../../../utils";
import { CID } from 'kubo-rpc-client';
import { BlsCircuit, BlsDID } from '../utils/crypto/bls-did';


export class BlockContainer {
    constructor() {

    }

    static fromObject(): BlockContainer {
        return new BlockContainer()
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

    
    async createBlock() {
      const transactions = await this.self.transactionPool.txDb.find({
        // $or: [
        //   {
        //     'headers.lock_block': {
        //       $lt: block_height
        //     }
        //   }, {
        //     'headers.lock_block': {
        //       $exists: false
        //     }
        //   }
        // ]
      }).toArray()

      const offchainTxs = transactions.filter(e => {
        return e.src === 'vsc'
      })

      const onchainTxs = transactions.filter(e => {
        return e.src === 'hive'
      })

      
      let hiveMerkleProof 
      if(onchainTxs.length > 0) {
        const txIds = onchainTxs.map(e => e.id);
        const leaves =txIds.map(x => SHA256(x))
        const tree = new MerkleTree(leaves, SHA256)
        const root = tree.getRoot().toString('hex')
        console.log(root)
        const proof = tree.getProof(SHA256(txIds[0]))
        console.log(proof)
        console.log('onchainTxs', onchainTxs.map(e => e.id))
        hiveMerkleProof = root;
      } else {
        hiveMerkleProof = '0'.repeat(64)
      }


      const blockFull = {
        __t: 'vsc-block',
        __v: '0.1',
        // required_auths: [
        //   {
        //     type: 'con'
        //     value: process.env.HIVE_ACCOUNT
        //   }
        // ]
        txs: [
          {
            id: hiveMerkleProof,
            type: "anchor_proof"
          }
        ],
        contract_index: {
          'null': []
        },
        merkle_root: null
      }
      return blockFull
    }

    async proposeBlock(block_height: number) {

      const blockFull = await this.createBlock()

      const sigPacked = await this.self.consensusKey.signObject(blockFull)
      console.log('sigPacked', sigPacked)

      const encodedPayload = await encodePayload(blockFull)

      const {drain} = await this.self.p2pService.memoryPoolChannel.call('propose_block', {
        payload: {
          block_height,
          hash: encodedPayload.cid.toString(),
        },
        mode: 'stream',
        streamTimeout: 12_000
      })
      const circuit = new BlsCircuit(blockFull)
      for await(let sigMsg of drain) {
        console.log('sigMsg', sigMsg)
        const pub = JSON.parse(Buffer.from(sigMsg.payload.p, 'base64url').toString()).pub
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
          const keys = await this.self.chainBridge.getWitnessesAtBlock(block_height)
          console.log(keys.map(e => {
            console.log(e)
            return e.keys.find(e => e.t === 'consensus')?.key
          }).filter(e => !!e))
          console.log('result', result)
        }
        console.log('aggregated DID', circuit.did.id)
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
          if(scheduleSlot.account === process.env.HIVE_ACCOUNT) {
            console.log('I can actually produce a block!')
            await this.proposeBlock(block_height)
          } else {
            const blockFull = await this.createBlock()
            this._candidateBlocks[block_height] = blockFull
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
      if(cadBlock) {
        const signData = await this.self.consensusKey.signRaw((await encodePayload(cadBlock)).cid.bytes)
        console.log(signData)
        
        drain.push(signData)
      }
      const cid = CID.parse(message.hash)
      const signData = await this.self.consensusKey.signRaw(cid.bytes)
      console.log(signData)

      drain.push(signData)
    }

    async init() {
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