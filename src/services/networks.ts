export default {
    //LEGACY DONT USE
    "testnet/ab8b6cf1-b344-4ad3-8f81-f2d72c61f6b2": {
        genesisDay: 70790692,
        roundLength: 20,
        //10 Rounds per every consensus period. 
        //Thus 20 blocks per round * 3 seconds = 60 * 10 = 600 seconds = 10 minutes
        consensusRoundLength: 10, 
        multisigAccount: "null"
    },
    //TESTNET v2
    "testnet/d12e6110-9c8c-4498-88f8-67ddf90d451c": {
        genesisDay: 74869131,
        roundLength: 10, //30 seconds
        //10 Rounds per every consensus period. 
        //Thus 20 blocks per round * 3 seconds = 60 * 10 = 600 seconds = 10 minutes
        consensusRoundLength: 10, 
        multisigAccount: 'vsc.ptk-d12e6110'
    }
} as Record<string, {
    genesisDay: number,
    roundLength: number
    multisigAccount?: string
}>