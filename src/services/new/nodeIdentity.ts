import nodeSchedule from 'node-schedule'
import { NewCoreService } from '.'
import { HiveClient } from '../../utils'

/**
 * Handles management of node identity, node info and general functions
 */
export class NodeIdentity {
    self: NewCoreService
    constructor(coreService) {
        this.self = coreService
        
        this.reportWitnesses = this.reportWitnesses.bind(this)
    }


    /**
     * Reports list of registered & active witnesses for debug purposes 
     */
    async reportWitnesses() {
        const currentBlock = await HiveClient.blockchain.getCurrentBlockNum()

        // const originalWitneses = (await this.self.oldService.witness.witnessNodes()).map( e => e.account)

        // const witnesses = await this.self.chainBridge.getWitnessesAtBlock(currentBlock)
        // console.log('Witneses at block', witnesses.map(e => e.account).sort())

    }

    async init() {

    }
    
    async start() {
        try {
            // await this.reportWitnesses()
            nodeSchedule.scheduleJob('0 */6 * * *', this.reportWitnesses)
        } catch (ex) {
            console.log(ex)
        }
    }

    async stop() {

    }
}