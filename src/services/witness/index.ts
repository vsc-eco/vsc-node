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
  constructor(self: CoreService) {
    this.self = self
  }

  async witnessNodes() {
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
      // trusted: true,
      net_id: this.self.config.get('network.id'),
      enabled_at: {
        $lt: consensusRound.pastRoundHash,
      },
      last_signed: {
        $gt: moment().subtract('3', 'day').toDate()
      }
    }, {
      sort: {
        account: -1
      }
    })
    .toArray()

    return witnessNodes;
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
        // trusted: true,
        net_id: this.self.config.get('network.id'),
        enabled_at: {
          $lt: consensusRound.pastRoundHash,
        },
        last_signed: {
          $gt: moment().subtract('3', 'day').toDate()
        }
      }, {
        sort: {
          account: -1
        }
      })
      .toArray()

      //console.log('witnessNodes', witnessNodes.map(e => e.account), witnessNodes.map(e => e.account).length)

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

    return await this.applyBNSchedule(outSchedule)
  }

  async calculateConsensusRound() {
    const {roundLength, totalRounds} = networks[this.self.config.get('network.id')];
    const blockNumber = await HiveClient.blockchain.getCurrentBlockNum()

    

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
        
        this.witnessSchedule = await this.weightedSchedule(networks[this.self.config.get('network.id')].totalRounds)
        // console.log('witnessSchedule', this.witnessSchedule)
      } catch (ex) {
        console.log(ex)
      }
    }, 15 * 1000)
    // await this.weightedSchedule(60)
  }
}