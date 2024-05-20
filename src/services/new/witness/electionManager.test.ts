import {
  MAX_BLOCKS_SINCE_LAST_ELECTION,
  MIN_BLOCKS_SINCE_LAST_ELECTION,
  minimalRequiredElectionVotes,
} from './electionManager'

describe('Election Manager', () => {
  describe('minimalRequiredElectionVotes', () => {
    it('fails when blocks since last election is too small', () => {
      expect(() => minimalRequiredElectionVotes(MIN_BLOCKS_SINCE_LAST_ELECTION - 1, 0)).toThrow()
    })

    it('returns 1/2 + 1 members at max blocks and members even', () => {
      expect(minimalRequiredElectionVotes(MAX_BLOCKS_SINCE_LAST_ELECTION, 8)).toBe(5)
    })

    it('returns 1/2 + 1 members at max blocks and members odd', () => {
      expect(minimalRequiredElectionVotes(MAX_BLOCKS_SINCE_LAST_ELECTION, 9)).toBe(5)
    })

    it('returns 1/2 + 1 members greater than max blocks and members even', () => {
      expect(minimalRequiredElectionVotes(MAX_BLOCKS_SINCE_LAST_ELECTION + 1, 8)).toBe(5)
    })

    it('returns 1/2 + 1 members greater than blocks and members odd', () => {
      expect(minimalRequiredElectionVotes(MAX_BLOCKS_SINCE_LAST_ELECTION + 1, 9)).toBe(5)
    })

    it('returns 2/3 members at min blocks and members even', () => {
      expect(minimalRequiredElectionVotes(MIN_BLOCKS_SINCE_LAST_ELECTION, 8)).toBe(6)
    })

    it('returns 2/3 members at min blocks and members odd', () => {
      expect(minimalRequiredElectionVotes(MIN_BLOCKS_SINCE_LAST_ELECTION, 9)).toBe(6)
    })

    it('returns ~7/12 members half way between min & max blocks and members even', () => {
      expect(
        minimalRequiredElectionVotes(
          (MAX_BLOCKS_SINCE_LAST_ELECTION - MIN_BLOCKS_SINCE_LAST_ELECTION) / 2,
          100,
        ),
      ).toBe(59)
    })

    it('returns ~7/12 members half way between min & max blocks and members odd', () => {
      expect(
        minimalRequiredElectionVotes(
          (MAX_BLOCKS_SINCE_LAST_ELECTION - MIN_BLOCKS_SINCE_LAST_ELECTION) / 2,
          101,
        ),
      ).toBe(60)
    })
  })
})
