import networks from '../../networks'
import { calculateConsensusRound, weightedSchedule } from './schedule'

const network = networks['testnet/0bf2e474-6b9e-4165-ad4e-a0d78968d20c']

describe('schedule', () => {
    describe('calculateConsensusRound', () => {
        it('should work in between rounds', () => {
            const block = 10
            const round = calculateConsensusRound(block, network)
            expect(round.currentBlockNumber).toBe(block)
            expect(round.nextRoundHeight).toBe(1200)
            expect(round.pastRoundHeight).toBe(0)
        })
        it('should work at the start of rounds', () => {
            const block = 0
            const round = calculateConsensusRound(block, network)
            expect(round.currentBlockNumber).toBe(block)
            expect(round.nextRoundHeight).toBe(1200)
            expect(round.pastRoundHeight).toBe(0)
        })
        it('should work at the end of rounds', () => {
            const block = 1200
            const round = calculateConsensusRound(block, network)
            expect(round.currentBlockNumber).toBe(block)
            expect(round.nextRoundHeight).toBe(2400)
            expect(round.pastRoundHeight).toBe(1200)
        })
    })

    describe('weightedSchedule', () => {
        type Params = Parameters<typeof weightedSchedule>;
        type WitnessNodes = Params[1];
        type RandomizeHash = Params[2];

        type Return = ReturnType<typeof weightedSchedule>;
        type Schedule = Return['schedule'];

        const account = (name: string): WitnessNodes[number] => ({
          account: name,
          key: 'redacted',
        })

        const tests: {
          it: string
          inputs: {
            block: number
            witnessNodes: WitnessNodes
            randomizeHash: RandomizeHash
          }
          outputs: {
            schedule: Schedule
          }
        }[] = [
          {
            it: 'should work',
            inputs: {
              // 0, 1, ..., 8, 9, 10, 11
              // 0, 10, 20, 30, ...
              block: 8, // in_past === true, for all bn < block
              // missing some or all elections
              witnessNodes: [account('A'), account('B'), account('C')], // which data is getting randomized
              // missing hive blocks or bad data
              randomizeHash: '', // the rng seed used to randomize ^
            },
            outputs: {
              schedule: [], // using snapshot since array is too long for this file
            },
          },
        ]

        for (const test of tests) {
            it(test.it, () => {
                const {block, witnessNodes, randomizeHash} = test.inputs
                const round = calculateConsensusRound(block, network)
                const {schedule} = weightedSchedule(network, witnessNodes, randomizeHash, round)
                expect(schedule).toMatchSnapshot()
            })
        }
    })
})