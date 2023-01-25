export default {
    "testnet/ab8b6cf1-b344-4ad3-8f81-f2d72c61f6b2": {
        genesisDay: 70790692,
        roundLength: 20,
        //10 Rounds per every consensus period. 
        //Thus 20 blocks per round * 3 seconds = 60 * 10 = 600 seconds = 10 minutes
        consensusRoundLength: 10, 
    }
} as Record<string, {
    genesisDay: number,
    roundLength: number
}>