import { CoreService } from "..";


export class MultisigCore {
    self: CoreService;

    constructor(self: CoreService) {
        this.self = self;
    }


    async keyRotate() {
        
    }

    async start() {
        this.self.p2pService.multicastChannel.register('multisig.request_rotate', async({
            drain,
            from
        }) => {
            await this.self.p2pService.peerDb.findOne({
                
            })
        })
        this.self.p2pService.multicastChannel.register('multisig.custom_json', async({
            drain,
            from
        }) => {
            await this.self.p2pService.peerDb.findOne({

            })
        })
    }
}