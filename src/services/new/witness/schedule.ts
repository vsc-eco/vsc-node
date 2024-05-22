import networks from '../../../services/networks'
import seedrandom from 'seedrandom'
import type { WithId } from 'mongodb'
import type { ElectionResult } from './electionManager'
import type { NewCoreService } from '..'
import type { WitnessServiceV2 } from '.'

function seedRand(func: () => number, min: number, max: number): number {
  return Math.floor(func() * (max - min + 1)) + min
}

function shuffle<T>(arr: T[], seed: string): T[] {
  const size = arr.length
  const rng = seedrandom(seed)
  const resp: T[] = []
  const keys: number[] = []

  for (let i = 0; i < size; i++) keys.push(i)
  for (let i = 0; i < size; i++) {
    const r = seedRand(rng, 0, keys.length - 1)
    const g = keys[r]
    keys.splice(r, 1)
    resp.push(arr[g])
  }
  return resp
}

type WithScheduleBN<T> = T & {
  bn: number
  bn_works: boolean
  in_past: boolean
}

/**
 * Applies block numbers to witness schedule
 */
function applyBNSchedule<T>(
  schedule: T[],
  network: NetworkInfo,
  consensusRound: ConsensusRound,
): WithScheduleBN<T>[] {
  const { roundLength } = network

  return schedule.map((e, index) => {
    return {
      ...e,
      bn: consensusRound.pastRoundHeight + index * roundLength,
      bn_works: (consensusRound.pastRoundHeight + index * roundLength) % roundLength === 0,
      in_past:
        consensusRound.pastRoundHeight + index * roundLength < consensusRound.currentBlockNumber,
    }
  })
}

function weightedSchedule(
  network: NetworkInfo,
  witnessNodes: {
    account: string
    key: string
  }[],
  electionResult: WithId<ElectionResult>,
  randomizeHash: string,
  consensusRound: ConsensusRound,
) {
  const { totalRounds } = network

  const outSchedule: {
    account: string
    key: string
  }[] = []
  for (let x = 0; x < totalRounds; x++) {
    if (witnessNodes[x % witnessNodes.length]) {
      outSchedule.push(witnessNodes[x % witnessNodes.length])
    }
  }

  const schedule = applyBNSchedule(shuffle(outSchedule, randomizeHash), network, consensusRound)

  return {
    schedule,
    valid_from: schedule[0]?.bn || 0,
    valid_to: schedule[outSchedule.length - 1]?.bn || 1,
    valid_epoch: electionResult.epoch,
  }
}

// networks[this.self.config.get('network.id')]
type NetworkInfo = typeof networks[keyof typeof networks]

type ConsensusRound = {
  nextRoundHeight: number
  pastRoundHeight: number
  currentBlockNumber: number
}

export function calculateConsensusRound(blockNumber: number, network: NetworkInfo): ConsensusRound {
  const { roundLength, totalRounds } = network

  const modLength = roundLength * totalRounds
  const mod3 = blockNumber % modLength
  const pastRoundHeight = blockNumber - mod3

  return {
    nextRoundHeight: blockNumber + (modLength - mod3),
    pastRoundHeight,
    currentBlockNumber: blockNumber,
  }
}

async function getRandomizeHashForBlock(
  { self }: { self: NewCoreService },
  consensusRound: ConsensusRound,
): Promise<string> {
  const { pastRoundHeight } = consensusRound

  //Return block id of previous block to round start.
  //This is used for schedule randomization
  const blockHeader = await self.chainBridge.events.findOne({
    key: pastRoundHeight - 1,
  })

  if (!blockHeader) {
    throw new Error(`could not find hive block header for block: ${pastRoundHeight - 1}`)
  }

  return blockHeader.block_id
}

export type Schedule = ReturnType<typeof weightedSchedule>['schedule']

/**
 * Get block producer schedule
 * @param blockHeight
 * @returns
 */
export async function getBlockSchedule(witness: WitnessServiceV2, blockHeight: number): Promise<Schedule> {
  const { self } = witness
  const network: NetworkInfo = networks[self.config.get('network.id')]
  const consensusRound = calculateConsensusRound(blockHeight, network)
  const electionResult = await self.electionManager.getValidElectionOfblock(blockHeight)
  // console.log(electionResult.epoch, this.witnessSchedule.valid_epoch, consensusRound.randomizeHash, this.witnessSchedule.valid_height)
  if (
    witness.witnessSchedule &&
    witness.witnessSchedule.valid_height === consensusRound.pastRoundHeight &&
    electionResult?.epoch === witness.witnessSchedule.valid_epoch
  ) {
    // console.log('this.witnessSchedule.valid_to', this.witnessSchedule.valid_height, blockHeight, consensusRound)
    return witness.witnessSchedule.schedule
  }

  const [witnessNodes, randomizeHash] = await Promise.all([self.electionManager.getMembersOfBlock(blockHeight),getRandomizeHashForBlock(witness, consensusRound)])

  const { schedule, valid_to, valid_from, valid_epoch } = weightedSchedule(
    network,
    witnessNodes,
    electionResult,
    randomizeHash,
    consensusRound,
  )

  witness.witnessSchedule = {
    schedule,
    valid_epoch,
    valid_height: consensusRound.pastRoundHeight,
  }

  return schedule
}
