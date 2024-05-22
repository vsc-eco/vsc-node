import { Collection } from "mongodb";
import Moment from 'moment'
import NodeSchedule from 'node-schedule'
import { CoreService } from "../..";
import { median } from "../../../utils";
import { NewCoreService } from "..";
import { WitnessServiceV2 } from ".";

/**
 * List of allowed interval notches for hive anchor record creation
 */
const ALLOWED_NOTCHES = [
    //3, // 10 seconds;
    // If processing delays were close to 3s max and broadcast under 3s
    5, // 15 seconds; 
    // ^ optimal performance while allowing for processing delays
    10, // 30 seconds
    15, // 45 seconds
    20, // 60 seconds
]

const MAX_RECORDS = 300;

export class DelayMonitor {
    self: NewCoreService;
    witness: WitnessServiceV2;
    delayMarks: Collection<{value: number, ts: Date}>;
    constructor(self: NewCoreService, witness: WitnessServiceV2) {
        this.self = self;
        this.witness = witness

        
        this.gatherAverages = this.gatherAverages.bind(this)
        this.runMark = this.runMark.bind(this)
    }

    async runMark() {
        await this.delayMarks.insertOne({
            ts: new Date(),
            value: this.self.chainBridge.parseLag
        })
        await this.delayMarks.deleteMany({
            _id: {
                $nin: [
                    ...(await this.delayMarks.find({

                    }, {
                        sort: {
                            ts: -1
                        },
                        limit: MAX_RECORDS
                    }).toArray()).map(e => e._id)
                ]
            }
        })
    }

    async gatherAverages() {
        const markers = await this.delayMarks.find({
            ts: {
                $gt: Moment().subtract('1', 'day').toDate()
            }
        }).toArray()

        //8 hours at 5 minute gather intervals
        if(markers.length < 100) {
            //Not enough data default to lowest consensus interval.
            return ALLOWED_NOTCHES[ALLOWED_NOTCHES.length - 1];
        } else {
            let avgDelay = median(markers.map(e => e.value)) /*.reduce((e, r) => {
                return e + r;
            })
            
            let avgDelay = totalDelay / markers.length;*/

            const allowedNotch = ALLOWED_NOTCHES.find((n) => {
                //Requires delay to leave enough room for P2P, and processing of the next block.
                return n > (avgDelay * 1.5)
            }) || ALLOWED_NOTCHES[ALLOWED_NOTCHES.length - 1]
            return allowedNotch;
        }
    }

    async start() {
        this.delayMarks = this.self.db.collection('delay_marks')
        console.log('delay monitor is running!')
        
        // if(this.self.mode !== 'lite') {
        NodeSchedule.scheduleJob('*/5 * * * *', this.runMark)
        NodeSchedule.scheduleJob('*/5 * * * *', async() => {
            console.log('Delay notch', await this.gatherAverages())
        })
        // }
    }
}