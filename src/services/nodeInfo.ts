import { TileDocument } from "@ceramicnetwork/stream-tile";
import { CoreService } from "./index";


export class NodeInfoService {
    self: CoreService;
    constructor(self: CoreService) {
        this.self = self
    }
    async announceNode() {
        /**
         * TODO
         * 
         * This function should set the IPFS peer ID in the DID metadata section indicating the wallet DID points to this nodes IPFS daemon.
         * This ensure there is a trust link between the IPFS daemon and the DID used for chain identity.
         * Once established, other nodes can index and identify each other and create partner relationships for smart contract execution or data exchange.
         * 
         */
    }
    async start() {

    }
}