const networks = new Proxy({
    //LEGACY DONT USE
    "testnet/ab8b6cf1-b344-4ad3-8f81-f2d72c61f6b2": {
        genesisDay: 70790692,
        roundLength: 20,
        totalRounds: 60,
        //10 Rounds per every consensus period. 
        //Thus 20 blocks per round * 3 seconds = 60 * 10 = 600 seconds = 10 minutes
        consensusRoundLength: 10, 
        multisigAccount: "null"
    },
    //Old testnet 
    "testnet/d12e6110-9c8c-4498-88f8-67ddf90d451c": {
        genesisDay: 74869131,
        roundLength: 10, //30 seconds
        totalRounds: 120,
        //10 Rounds per every consensus period. 
        //Thus 20 blocks per round * 3 seconds = 60 * 10 = 600 seconds = 10 minutes
        consensusRoundLength: 10, 
        multisigAccount: 'vsc.ptk-d12e6110'
    },
    //New testnet
    'testnet/0bf2e474-6b9e-4165-ad4e-a0d78968d20c': {
        genesisDay: 81614028,
        roundLength: 10, //15 seconds
        totalRounds: 120,
        //10 Rounds per every consensus period. 
        //Thus 20 blocks per round * 3 seconds = 60 * 10 = 600 seconds = 10 minutes
        consensusRoundLength: 10,
        multisigAccount: 'vsc.gateway'
    }
} as const, {
    get(target, p, receiver) {
        if (!Object.prototype.hasOwnProperty.call(target, p)) {
            throw new Error(`unknown network selected: ${String(p)}`)
        }
        return Reflect.get(target, p, receiver)
    },
})

/**
 * List of network configurations
 * 
 * @throws if network id is not in the list
 */
export default networks