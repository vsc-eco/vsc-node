import networks from "../../../services/networks";
import type { WitnessServiceV2 } from ".";
import { NewCoreService } from "..";
import { ParserFuncArgs } from "../utils";

const BLOCKS_TO_WAIT = 5;

export class SlotTracker {
    lastValidSlot: number = 0;

    constructor(readonly self: NewCoreService, readonly witness: WitnessServiceV2) {
        this.blockParser = this.blockParser.bind(this);
    }

    async blockParser({data: {key: block_height}}: ParserFuncArgs<'block'>) {
        const roundLength = networks[this.self.config.get('network.id') as keyof typeof networks].roundLength;
        const blocksSinceLastSlot = +block_height % roundLength;
        if (blocksSinceLastSlot !== BLOCKS_TO_WAIT) {
            return;
        }

        if (this.self.chainBridge.parseLag >= BLOCKS_TO_WAIT) {
            return;
        }

        const slot_height = +block_height - BLOCKS_TO_WAIT;

        const blockHeader = await this.witness.blockHeaders.findOne({
            slot_height,
        });

        if (blockHeader) {
            console.log(`@${blockHeader.proposer} anchored their proposed block`)
            return;
        }

        const schedule = await this.witness.getBlockSchedule(slot_height);
        const scheduled = schedule.find(({bn}) => bn === slot_height);
        
        if (!scheduled) {
            throw new Error('could not compute the schedule for slot height: ' + slot_height);
        }

        if (this.lastValidSlot !== slot_height) {
            console.log(`@${scheduled.account} missed their proposal slot`)
        } else {
            console.log(`@${scheduled.account} did not get enough signatures`)
        }
    }

    async init() {
        this.self.chainBridge.streamParser.addParser({
            name: 'slotTracker',
            type: 'block',
            priority: 'after',
            func: this.blockParser
        })
    }

    async start() {}
}