import { HiveClient } from "../../utils";
import { CoreService } from "../";
import { Collection } from "mongodb";


export class WitnessService {
    self: CoreService;
    witnessDb: Collection;
    constructor(self: CoreService) {
        this.self = self;
    }


    async proposeRound() {
        
    }

    async start() {
        this.witnessDb = this.self.db.collection('witnesses')
        
    }
}