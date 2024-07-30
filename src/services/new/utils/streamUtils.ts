import { Collection, WithId } from 'mongodb'

import { fastStream, sleep } from "../../../utils";
import { HiveTransactionDbRecord } from '../types';



export interface EventRecord {
    id: "hive_block"
    key: string | number
    transactions: HiveTransactionDbRecord[]
    block_id: string
    timestamp: Date
}

type FilterFunction = (txData: {
    tx: any
}) => {
    pass: boolean
}


export type ParserFuncArgs<Type extends 'block' | 'tx'> = {
    halt: () => Promise<void>
} &( Type extends 'block'? {
    type: 'block'
    data: WithId<EventRecord>
} : {
    type: 'tx'
    data:     {
        tx: EventRecord['transactions'][0]
        blkHeight: number
    } & Pick<EventRecord, 'block_id' | 'timestamp'>
})

export type ParserFunc<Type extends 'block' | 'tx'> = (args: ParserFuncArgs<Type>) => Promise<void>

type Parser<Type extends 'block' | 'tx'> = {
  priority: 'before' | 'after' | number
  type: Type
  func: ParserFunc<Type>
}

/**
 * Wrapping util for handling the separation between business logic <--> StreamParser <--> Hive stream
 */
export class StreamParser {
    stream: fastStream;
    events: Collection<EventRecord>
    streamState: Collection;
    genesisDay: number;


    parsers: Array<Parser<'block' | 'tx'>>
    filters: Array<{
        func: FilterFunction
    }>
    lastParsed: number;
    constructor({
        events,
        streamState,
        genesisDay
    }: {events: Collection<EventRecord>, streamState: Collection, genesisDay: number}) {
        this.events = events
        this.streamState = streamState
        this.genesisDay = genesisDay;

        this.addFilter = this.addFilter.bind(this)
        this.addParser = this.addParser.bind(this)
        this.halt = this.halt.bind(this)

        this.filters = []
        this.parsers = []

    }


    async halt() {
        this.stream.pauseStream();

        //Promise to never resolve
        await new Promise(() => {})
    }


    /**
     * Prefilters transactions in the events sub section
     */
    addFilter(args: {
        func: FilterFunction
    }) {
        this.filters.push(args)
    }

    addParser<ParserType extends 'block' | 'tx'>(args: {
        priority: "before" | "after" | number
        type: ParserType
        func: ParserFunc<ParserType>
        name?: string
    }) {
        this.parsers.push(args)
    }

    async _processBlock([block_height, block]) {
        // console.log(block)
        let transactions = []
        for (let tx of block.transactions) {
            // console.log(tx)
            const [op, opPayload] = tx.operations[0]


            for(let filter of this.filters) {

                const result = filter.func({
                    tx
                })
                if(result.pass) {
                    transactions.push({
                        operations: tx.operations,
                        transaction_id: tx.transaction_id,
                        index: block.transactions.indexOf(tx)
                    })
                }
            }
        }
        
        await this.events.updateOne({
            id: 'hive_block',
            key: block_height
        }, {
            $set: {
                block_id: block.block_id,
                timestamp: new Date(block.timestamp + 'Z'),
                transactions
            }
        }, {
            upsert: true
        })
    }
    
    
    async processEventStream() {
        let lastBlock;

        const lastProcessed = await this.streamState.findOne({
            id: 'last_hb_processed'
        })

        if(lastProcessed) {
            lastBlock = lastProcessed.val
            this.lastParsed = lastBlock
        }


        if (!lastBlock) {
            //Search for very first hive block.
            while (true) {
                const firstBlock = (await this.events.findOne({
                    id: "hive_block"
                }, {
                    sort: {
                        key: 1
                    }
                }));
                if(firstBlock) {
                    lastBlock = firstBlock.key
                    break;
                } else {
                    await sleep(1_000)
                }
            }
        }

        

        
        //Block handlers
        const priorityBlockExec = [
            ...Object.values(this.parsers).filter(e => typeof e.priority === 'number' && e.type === 'block').sort(
                (a, b) => {
                    return (a.priority as number) - (b.priority as number)
                }
            ),
            ...Object.values(this.parsers).filter(e => e.priority === 'before' && e.type === 'block')
        ]

        const afterBlockExec = Object.values(this.parsers).filter(e => e.priority === 'after' && e.type === 'block')

        //Tx handlers
        const priorityTxExec = [
            ...Object.values(this.parsers).filter(e => typeof e.priority === 'number' && e.type === 'block').sort(
                (a, b) => {
                    return (a.priority as number) - (b.priority as number)
                }
            ),
            ...Object.values(this.parsers).filter(e => e.priority === 'before' && e.type === 'tx')
        ]

        const afterTxExec = Object.values(this.parsers).filter(e => e.priority === 'after' && e.type === 'tx')
        

        // console.log({
        //     priorityBlockExec,
        //     afterBlockExec,
        //     priorityTxExec,
        //     afterTxExec
        // })

        const parser1 = [...priorityBlockExec, ...afterBlockExec]
        const parser2 =  [...priorityTxExec, ...afterTxExec]

        while (true) {
            const blocks = await this.events.find({
                id: 'hive_block',
                key: { $gt: lastBlock }
            }, {
                sort: {
                    key: 1
                },
                limit: 1_000
            }).toArray()
            

            if (blocks.length === 0) {
                await sleep(2_000)
            }
            for (let blk of blocks) {
                for(let parser of parser1) {
                    try { 
                        await parser.func({
                            type: 'block',
                            data: blk,
                            halt: this.halt
                        })
                    } catch (ex) {
                        console.log(ex)
                        //TODO: log errors into proper location
                    }
                }

                for (let tx of blk.transactions) {
                    for(let parser of parser2) {
                        try {
                            await parser.func({
                                type: 'tx',
                                data: {
                                    tx,
                                    //Fix: to underscore case.
                                    blkHeight: Number(blk.key),
                                    block_id: blk.block_id,
                                    timestamp: blk.timestamp
                                },
                                halt: this.halt
                            })
                        } catch(ex) {
                            console.log(ex)
                            //TODO: log errors into proper location
                        }
                    }
                }
                
                lastBlock = blk.key
                this.lastParsed = lastBlock;
                if(lastBlock % 100 === 0) {
                    await this.streamState.updateOne({
                        id: 'last_hb_processed'
                    }, {
                        $set: {
                            val: lastBlock
                        }
                    }, {
                        upsert: true
                    })

                } else if(this.lastParsed + 20 > this.stream.headHeight) {
                    await this.streamState.updateOne({
                        id: 'last_hb_processed'
                    }, {
                        $set: {
                            val: lastBlock
                        }
                    }, {
                        upsert: true
                    })
                }
            }
            //TODO: handle commiting after X has completed
        }
    }


    async init() {
        this.stream = await fastStream.create({
            startBlock: this.genesisDay
        })
        await this.stream.init()
        void (async () => {
            let lastBlk;
            setInterval(async () => {
                if (lastBlk) {
                    await this.streamState.updateOne({
                        id: 'last_hb'
                    }, {
                        $set: {
                            val: lastBlk
                        }
                    }, {
                        upsert: true
                    })
                }
            }, 1000)
            for await (let [block_height, block] of this.stream.streamOut) {
                // console.log('processing block', block_height)
                await this._processBlock([block_height, block])
                lastBlk = block_height
            }
        })()
    }
    
    async start() {
        this.stream.startStream()
        this.processEventStream()
    }
}