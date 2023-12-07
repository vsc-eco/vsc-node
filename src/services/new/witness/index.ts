import networks from "../../../services/networks";
import { NewCoreService } from "..";
import { HiveClient } from "../../../utils";


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

    constructor(self: NewCoreService) {
        this.self = self;

        this.blockTick = this.blockTick.bind(this)

        this.witnessSchedule = {
            valid_to: null
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

      
    async proposeBlock() {
        // const transactions = await this.self.
    }

    async verifyBlock() {

    }

    async blockTick(block) {
        const block_height = block.key;
        console.log('block_height', block_height)
        const schedule = await this.roundCheck(block_height)

        const scheduleSlot = schedule.find(e => e.bn === block_height)
        if(!!scheduleSlot && scheduleSlot.account === process.env.HIVE_ACCOUNT && this.self.chainBridge.stream.blockLag < 3) {
            console.log('I can actually produce a block!')
            await this.proposeBlock()
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

    async init() {
        this.self.chainBridge.registerTickHandle('witness.blockTick', this.blockTick)

        const bn = await HiveClient.blockchain.getCurrentBlockNum()
        const schedule = await this.weightedSchedule(networks[this.self.config.get('network.id')].totalRounds, bn)
        console.log(schedule)
    }

    async start() {

    }
}