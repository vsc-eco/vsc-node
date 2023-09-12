import { Collection } from "mongodb";
import Crypto from 'crypto'
import { Ed25519Provider } from "key-did-provider-ed25519";
import KeyResolver from 'key-did-resolver'
import { DID } from "dids";
import shuffleSeed from 'shuffle-seed'
import { CoreService } from "../";
import { HiveClient } from "../../utils";
import moment from "moment";
import { createSafeDivision } from "./multisig";
import { DelayMonitor } from "./delayMonitor";
import networks from "../networks";



export class WitnessService {
  self: CoreService
  witnessDb: Collection
  witnessSchedule: Array<{
    account: string
    bn: Number
    bn_works: boolean
    in_past: boolean
    did: string
  }>
  delayMonitor: DelayMonitor;
  constructor(self: CoreService) {
    this.self = self

    this.delayMonitor = new DelayMonitor(this.self, this)
  }

  async weightedSchedule(totalRounds) {
    const consensusRound = await this.calculateConsensusRound()
    const witnessNodes = await this.witnessDb
      .find({
        $or: [
          {
            disabled_at: {
              $gt: consensusRound.pastRoundHash,
            },
          },
          {
            disabled_at: {
              $exists: false,
            },
          },
          {
            disabled_at: {
              $eq: null
            },
          },
        ],
        trusted: true,
        net_id: this.self.config.get('network.id'),
        enabled_at: {
          $lt: consensusRound.pastRoundHash,
        },
        last_signed: {
          $gt: moment().subtract('7', 'day').toDate()
        }
      })
      .toArray()

      console.log('witnessNodes', witnessNodes.map(e => e.account), witnessNodes.map(e => e.account).length)

      // console.log(JSON.stringify({
      //   $or: [
      //     {
      //       disabled_at: {
      //         $gt: consensusRound.pastRoundHash,
      //       },
      //     },
      //     {
      //       disabled_at: {
      //         $exists: false,
      //       },
      //     },
      //     {
      //       disabled_at: {
      //         $eq: null
      //       },
      //     },
      //   ],
      //   trusted: true,
      //   net_id: this.self.config.get('network.id'),
      //   enabled_at: {
      //     $lt: consensusRound.pastRoundHash,
      //   },
      //   // last_signed: {
      //   //   $gt: moment().subtract('5', 'day').toDate()
      //   // }
      // }))

      // console.log(
      //   witnessNodes.map((e) => e.account),
      //   witnessNodes.map((e) => e.account).length,
      //   /*JSON.stringify({
      //     enabled_at: {
      //       $lt: consensusRound.pastRoundHash,
      //     },
      //     $or: [
      //       {
      //         disabled_at: {
      //           $gt: consensusRound.pastRoundHash,
      //         },
      //       },
      //       {
      //         disabled_at: {
      //           $exists: false,
      //         },
      //       },
      //       {
      //         disabled_at: {
      //           $eq: null,
      //         },
      //       },
      //     ],
      //   }, null, 2)*/
      // )
    // const block = await HiveClient.database.getBlockHeader(consensusRound.pastRoundHash - 20 * 60)
    

    // const data = createSafeDivision({
    //   factorMin: 6,
    //   factorMax: 11,
    //   map: witnessNodes
    // })
    let outSchedule = []
    for (let x = 0; x < totalRounds; x++) {
      if (witnessNodes[x % witnessNodes.length]) {
        outSchedule.push(witnessNodes[x % witnessNodes.length])
      }
    }
    // console.log(outSchedule)
    // console.log(Crypto.randomBytes(32).toString('base64'))
    // outSchedule = shuffleSeed.shuffle(outSchedule, blockHash).map((e, index) => ({
    //     account: e.account,
    //     index: index * 20
    // }));
    // console.log((await this.applyBNSchedule(outSchedule)), witnessNodes.length, outSchedule.length)
    return await this.applyBNSchedule(outSchedule)
  }

  async calculateConsensusRound() {
    const blockNumber = await HiveClient.blockchain.getCurrentBlockNum()

    // const mod1 = blockNumber % 20;
    // console.log(mod1)
    // console.log(mod1 + blockNumber)
    // const mod2 = mod1 + blockNumber
    // console.log(mod2 % 20)

    const modLength = 20 * 60
    const mod3 = blockNumber % modLength
    const pastRoundHash = blockNumber - mod3
    // console.log(
    //   'blockNumber',
    //   blockNumber,
    //   'pastRoundHash',
    //   pastRoundHash % modLength,
    //   pastRoundHash,
    // )
    return {
      nextRoundHash: blockNumber + (modLength - mod3),
      pastRoundHash,
      currentBlockNumber: blockNumber,
    }
  }

  /**
   * Applies block numbers to witness schedule
   */
  async applyBNSchedule(schedule: any[]) {
    const consensusRound = await this.calculateConsensusRound()
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

  async start() {
    this.witnessDb = this.self.db.collection('witnesses')
    
    try {
      await this.witnessDb.createIndex({
        account: -1
      }, {
        unique: true
      })
    } catch(ex) {
      console.log(ex)
    }

    setInterval(async () => {
      try {
        this.witnessSchedule = await this.weightedSchedule(60)
        // console.log('witnessSchedule', this.witnessSchedule)
      } catch (ex) {
        console.log(ex)
      }
    }, 15 * 1000)
    // await this.weightedSchedule(60)

    
    await this.delayMonitor.start()
  }
}