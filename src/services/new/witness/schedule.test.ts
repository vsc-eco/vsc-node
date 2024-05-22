import networks from '../../networks'
import { calculateConsensusRound } from './schedule'

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
})