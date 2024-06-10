import { Collection } from "mongodb";
import Axios from 'axios'
import Moment from 'moment'
import { NewCoreService } from "..";
import { BlsCircuit } from "../utils/crypto/bls-did";
import networks from "../../../services/networks";
import { ParserFuncArgs } from "../utils/streamUtils";
import BitSet from "bitset";
import { CID } from "kubo-rpc-client";
import { HiveClient, todo, truthy } from "../../../utils";
import { PrivateKey } from "@hiveio/dhive";
import { VersionConfig } from "./versionManager";
import EventEmitter from 'node:events';


export interface ElectionResult {
    block_height: number
    epoch: number
    members: Array<{
        account: string
        key: string
    }>

    weights: Array<number>
    weight_total: number
}


interface ElectionResultSignedHeader {
    epoch: number
    data: string
    signature: {
        sig: string
        bv: string
    }
}


async function getGitTags(): Promise<Array<{
    ref: string
    node_id: string
    url: string
    object: {
        sha: string
        type: string
        url: string
    }
}>> {
    const {data} = await Axios.get('https://api.github.com/repos/vsc-eco/vsc-node/git/refs/tags')
    
    return data
}

async function getGitTagDate(tag: string): Promise<Date> {
    const {data} = await Axios.get('https://api.github.com/repos/vsc-eco/vsc-node/git/refs/tags')
    
    return data
}

class Range {
    private constructor(
        readonly start: number,
        readonly end: number,
    ) {
        if (end <= start) {
            throw new Error(`range error: end > start must be true {end: ${end}, start: ${start}}`)
        }
    }

    static from([start, end]: [number, number]) {
        return new Range(start, end);
    }

    position(value: number) {
        const {start, end} = this
        if (value < start || value > end) {
            throw new Error(`range error: value ${value} not in range [${start},${end}]`)
        }
        return (value - start) / (end - start)
    }

    value(position: number) {
        const {start, end} = this
        if (position < 0 || position > 1) {
            throw new Error(`range error: position ${position} not in range [0,1]`)
        }
        return position * (end - start) + start
    }

    map(value: number, to: Range) {
        const position = this.position(value)
        return to.value(position)
    }
}

export const MIN_BLOCKS_SINCE_LAST_ELECTION = 1200 // 1 hour
export const MAX_BLOCKS_SINCE_LAST_ELECTION = 403200 // 2 weeks

export function minimalRequiredElectionVotes(blocksSinceLastElection: number, memberCountOfLastElection: number): number {
    if (blocksSinceLastElection < MIN_BLOCKS_SINCE_LAST_ELECTION) {
        throw new Error('tried to run election before time slot')
    }
    const minMembers = Math.floor((memberCountOfLastElection / 2) + 1) // 1/2 + 1
    const maxMembers = Math.ceil(memberCountOfLastElection * 2 / 3) // 2/3
    const drift = (MAX_BLOCKS_SINCE_LAST_ELECTION - Math.min(blocksSinceLastElection, MAX_BLOCKS_SINCE_LAST_ELECTION)) / MAX_BLOCKS_SINCE_LAST_ELECTION;
    return Math.round(Range.from([0, 1]).map(drift, Range.from([minMembers, maxMembers])));
}

interface LogEntry {
    service: string
    message: string
    ts: Date
    index_id: number
    version_id: string
}

const REQUIRED_ELECTION_MEMBERS = [
    'vsc.node1', 'vsc.node2', 'vaultec-scc',
    'geo52rey.vsc', 'geo52rey.dev',
    'manu-node',
    'v4vapp.vsc',
    'lassecashwitness',
]

const EPOCH_122_BLOCK_HEIGHT = 85060812;


/**
 * Manages elections and upgrades 
 * This introduces consensus "epochs" where the schedule is determined and nodes are either excluded or inclided
 * Problems this attempts to solve
 * - Multisig key rotation, the issue of verifying the next validator set, ensure no stale validators
 * - Clear points where consensus traditions ocurr
 * - Clear records where withdrawels, deposits, and slashings occur as part of consensus 
 * - Exclusion/inclusion of nodes based on versioning
 */
export class ElectionManager {
    self: NewCoreService;
    electionDb: Collection<ElectionResult>
    epochLength: number;
    mongoLogs: Collection<LogEntry>;
    public readonly eventEmitter: EventEmitter<{
        'new-epoch': [{ 
            hive_block: number;
            epoch: number; 
            net_id: string; 
            members: Array<{ account: string; key: string }>;
        }]
    }> = new EventEmitter();
    constructor(self: NewCoreService) {
        this.self = self;

        

        this.btHoldElection = this.btHoldElection.bind(this)
        this.btIndexElection = this.btIndexElection.bind(this)
        this.handlePeerMsg = this.handlePeerMsg.bind(this)

        //Every 6 hours
        this.epochLength = 20 * 60 * 6
    }

    async log(message: string, opts?: any) {
        await this.mongoLogs.insertOne({
            service: 'electionMgr',
            message: message,
            ts: new Date(),
            ...(opts || {}),
            index_id: VersionConfig.index_reset_id,
            version_id: VersionConfig.version_id
        })
    }

    /**
     * Retrieves valid election as of N block height
     */
    async getValidElectionOfblockUnchecked(blkHeight: number) {
        const electionResult = await this.electionDb.findOne({
            block_height: {
                $lt: blkHeight
            }
        }, {
            sort: {
                block_height: -1
            }
        })
        return electionResult
    }

        /**
     * Retrieves valid election as of N block height
     */
    async getValidElectionOfblock(blkHeight: number) {
        const electionResult = await this.getValidElectionOfblockUnchecked(blkHeight)
        if (!electionResult) {
            throw new Error(`could not find election before block ${blkHeight}`)
        }
        return electionResult
    }

    //Gets valid members of N block height
    //Works across both 
    async getMembersOfBlock(blkHeight: number): Promise<Array<{account: string, key: string}>> {
        const election = await this.getValidElectionOfblockUnchecked(blkHeight)
        if(election) {
            return election.members
        } else {
            const witnesses = await this.self.chainBridge.getWitnessesAtBlock(blkHeight);

            return witnesses.map(e => {
                return {
                    account: e.account,
                    key: e.keys.find(b => b.t === 'consensus')?.key
                }
            }).filter((e): e is typeof e & {key: string} => truthy(e.key))
        }
    }

    /**
     * Generates a raw election graph from local data
     */
    async generateElection(blk: number) {
        // TODO refactor these calls into params
        const witnesses = await this.self.chainBridge.getWitnessesAtBlock(blk)
        const electionResult = await this.getValidElectionOfblockUnchecked(blk - 1)

        const gitTags = await getGitTags();
        const recentGitTags = gitTags.map(e => {
            return {
                tag:  e.ref.split('refs/tags/')[1],
                commit_url: e.object.url
            }
        }).filter((e) => e.tag.startsWith('v')).sort((a, b) => {
            return ('' + b.tag).localeCompare(a.tag);
        })
        
        let topDates: Array<{
            tag: string
            date: Date
        }> = []
        for(let tag of recentGitTags.slice(0, 1)) {
            const {data, headers} = await Axios.get(tag.commit_url)
            console.log(data)
            topDates.push({
                tag: tag.tag,
                date: new Date(data.tagger.date)
            })
        }
        
        const witnessList = witnesses.filter(e => {
            if (REQUIRED_ELECTION_MEMBERS.includes(e.account)) {
                return true;
            }
            if(topDates[0]) {
                if(topDates[0].date.getTime() > Moment().subtract('12', 'hours').toDate().getTime() && e.version_id === topDates[1]?.tag) {
                    //Check if node is using the older update & hasn't updated (yet)
                    return true
                } else if(e.version_id === topDates[0].tag) {
                    //Node is updated!
                    return true;
                } else {
                    // console.log('Node is not updated', e.account, e.version_id, topDates[0].tag, topDates[1]?.tag)
                    //All other cases
                    return false;
                }
            } else {
                //Assume there are no updates posted (yet)
                return true;
            }
        }).map(e => {
            return {
                account: e.account,
                key: e.keys.find(b => b.t === 'consensus')?.key
            }
        }).filter((e): e is typeof e & {key: string} => truthy(e.key));

        const optionalNodes = witnessList.filter(e => !REQUIRED_ELECTION_MEMBERS.includes(e.account))
        // const requiredNodes = witnessList.filter(e => REQUIRED_ELECTION_MEMBERS.includes(e.account))
        // const totalOptionalNodes = optionalNodes.length
        const scoreChart = await this.self.witness.getWitnessActiveScore(blk)

        const totalOptionalWeight = optionalNodes.map(e => {
            return {
                ...e,
                weight: scoreChart[e.account] ? scoreChart[e.account].weight : 0
            }
        }).map(e => e.weight).reduce((a, b) => a + b, 0)
        // const rNodes = 5
        // const oNodes = [1, 1, 1, 1, 1, 1, 1, 1, 1,1 ]

        // const oWeights = oNodes.reduce((a, b) => a + b, 0)
        // const rWeights = oWeights/2
        // rWeights/rNodes

    

        let distWeight = (1 + totalOptionalWeight/2 )/ REQUIRED_ELECTION_MEMBERS.length
        const members = [...witnessList]


        console.log(scoreChart)
        let weights = []
        for(let member of members) { 

            if(REQUIRED_ELECTION_MEMBERS.includes(member.account)) { 
                weights.push(Math.ceil(Number(distWeight.toFixed(2))))
            } else {
                weights.push(scoreChart[member.account] ? scoreChart[member.account].weight : 1)
            }
        }

        const electionData = {
            __t: 'vsc-election',
            __v: '0.1',
            members,
            //Iterate upon each successive consensus epoch
            epoch: electionResult ? electionResult.epoch + 1 : 0,

            // last_epoch: null,
            //For use when staking is active
            deposits: [],
            withdrawels: [],

            //List of weights in the election. Calculated by weights API
            weights: weights,
            weight_total: Number(weights.reduce((a, b) => a + b, 0).toFixed(1)),

            //net_id to prevent replay across testnets
            net_id: this.self.config.get('network.id')
        }
        
        return electionData;
    }

    async holdElection(blk:number) {
        const electionResult = await this.getValidElectionOfblockUnchecked(blk - 1)
        const electionData = await this.generateElection(blk)
        
        console.log('electionData - holding election', electionData)

        if(electionData.members.length < 8) {
            console.log("Minimum network config not met for election. Skipping.")
            return; 
        }

        const cid = await this.self.ipfs.dag.put(electionData)

        const electionHeader = {
            data: cid.toString(),
            epoch: electionData.epoch,
            net_id: this.self.config.get('network.id')
        }
        
        const signRaw = (await this.self.ipfs.dag.put(electionHeader)).bytes;
        const circuit = new BlsCircuit({
            hash: signRaw
        })
        
        const {drain} = await this.self.p2pService.multicastChannel.call('hold_election', {
            mode: 'stream',
            payload: {
                block_height: blk
            },
            streamTimeout: 20_000
        })

        const members = await this.getMembersOfBlock(blk)
        for await(let sigData of drain) {
            const pub = JSON.parse(Buffer.from(sigData.payload.p, 'base64url').toString()).pub
            const sig = sigData.payload?.s
            if(!members.find(e => {
                return e.key === pub
            })) {
                continue;
            }
            const verifiedSig = await circuit.verifySig({
                sig: sig,
                pub: pub,
            });
            console.log('aggregating the signature!', verifiedSig)
            if(verifiedSig) {
                await circuit.add({
                    did: pub,
                    sig
                })
            }
        }

        const pubKeys = []
        for(let key of circuit.aggPubKeys.keys()) {
            
            pubKeys.push(key)
        }

        let votedWeight = 0;
        let totalWeight = 0;
        if(electionData.weights) {
            //Vote based off weight
            for(let key of pubKeys) {
                const member = members.find(e => e.key === key)
                if(member) {
                    votedWeight += electionData.weights[members.indexOf(member)]
                }
            }
            totalWeight = electionData.weight_total
        } else {
            //Vote based off signer count
            votedWeight = pubKeys.length
            totalWeight = members.length
        }
        
        const voteMajority = minimalRequiredElectionVotes(electionHeader.epoch === 0 || !electionResult ? blk : blk - electionResult.block_height, totalWeight); //Hardcode for 0 until the future
        
        if(((votedWeight >= voteMajority) || electionHeader.epoch === 0)) {
            //Must be valid
            

            if (!process.env.HIVE_ACCOUNT) {
                throw new Error('no hive account... will not broadcast election result')
            }

            if (!process.env.HIVE_ACCOUNT_ACTIVE) {
                throw new Error('no hive account active key... will not broadcast election result')
            }
            
            await HiveClient.broadcast.json({
                id: 'vsc.election_result',
                required_auths: [process.env.HIVE_ACCOUNT],
                required_posting_auths: [],
                json: JSON.stringify({
                    ...electionHeader,
                    signature: circuit.serialize(members.map(e => e.key))
                })
            }, PrivateKey.fromString(process.env.HIVE_ACCOUNT_ACTIVE))
        }
    }

    async btHoldElection({data:block}: ParserFuncArgs<'block'>) {
        const blk = block.key
        // const drift = blk % this.epochLength;
        // const slotHeight = blk - drift
        if(+blk % this.epochLength === 0 && this.self.chainBridge.parseLag < 5) {
            const witnessSchedule = await this.self.witness.getBlockSchedule(+blk)
            const scheduleSlot = witnessSchedule.find(e => e.bn >= +blk)
            if(scheduleSlot && scheduleSlot.account === process.env.HIVE_ACCOUNT) {
                this.holdElection(+blk)
            }
        }
    }

    async btIndexElection(args: ParserFuncArgs<'tx'>) {
        const {data} = args;

        const {tx, blkHeight} = data;

        const [op, opPayload] = tx.operations[0]

        if(op === 'custom_json') {
            if (opPayload.id === 'vsc.election_result') {
                
                const members = await this.getMembersOfBlock(blkHeight)
                const json: {
                    data: string
                    epoch: number
                    net_id: string
                    signature: {
                        sig: string
                        bv: string
                    }
                } = JSON.parse(opPayload.json)
                const slotHeight = blkHeight - (blkHeight % this.epochLength)
                
                const circuit = BlsCircuit.deserialize(json, (await this.getMembersOfBlock(slotHeight)).map(e => e.key))
                const pubKeys: string[] = []
                for(let pub of circuit.aggPubKeys) {
                    pubKeys.push(pub[0])
                }
                

                const signedDataNoSig = JSON.parse(opPayload.json);
                delete signedDataNoSig.signature

                //Aggregate pubkeys
                circuit.setAgg(pubKeys)

                const isValid = await circuit.verify((await this.self.ipfs.dag.put({
                    data: json.data,
                    epoch: json.epoch,
                    net_id: json.net_id
                }, {
                    onlyHash: true
                })).bytes);

                const electionResult = await this.electionDb.findOne({
                    epoch: json.epoch,
                    net_id: json.net_id
                })
                console.log('Validing election result', isValid)

                const lastElection = await this.getValidElectionOfblockUnchecked(blkHeight)

                //Don't require 2/3 consensus for initial startup.
                
                
                let votedWeight = 0;
                let totalWeight = 0;
                if(lastElection.weights) {
                    //Vote based off weight
                    for(let key of pubKeys) {
                        const member = members.find(e => e.key === key)
                        if(member) {
                            votedWeight += lastElection.weights[members.indexOf(member)]
                        }
                    }
                    totalWeight = lastElection.weight_total
                } else {
                    //Vote based off signer count
                    votedWeight = pubKeys.length
                    totalWeight = members.length
                }
                
                const voteMajority = blkHeight < EPOCH_122_BLOCK_HEIGHT ? totalWeight * 2 / 3 : minimalRequiredElectionVotes(!lastElection ? blkHeight : blkHeight - lastElection.block_height, totalWeight)

                
                if(isValid && ((votedWeight >= voteMajority) || json.epoch === 0)) {
                    //Must be valid
                    const fullContent = (await this.self.ipfs.dag.get(CID.parse(json.data))).value


                    if(!electionResult) {
                        await this.electionDb.findOneAndUpdate({
                            epoch: fullContent.epoch,
                            net_id: fullContent.net_id
                        }, {
                            $set: {
                                members: fullContent.members,
                                block_height: blkHeight,
                                data: json.data,
                                proposer: opPayload.required_auths[0],
                            }
                        }, {
                            upsert: true
                        })
                        this.eventEmitter.emit('new-epoch', { hive_block: blkHeight, epoch: json.epoch, net_id: json.net_id, members })
                    } else {
                        await this.log(`Election result already exists for epoch ${json.epoch}`)
                    }
                } else {
                    console.log(json)
                    await this.log(`Election result failed validation for epoch ${json.epoch}`, {
                        sig: json.signature?.sig,
                        bv: json.signature?.bv,
                        isValid,
                        totalMembers: members.length,
                        signedMembers: pubKeys.length
                    })
                }
            }
        }
    }

    async handlePeerMsg(data) {
        const election = await this.generateElection(data.message.block_height)
        if(data.message.block_height % this.epochLength === 0 || data.message.block_height % 40 === 0) {
            const signRaw = (await this.self.ipfs.dag.put({
                data: (await this.self.ipfs.dag.put(election, {
                    pin: true
                })).toString(),
                epoch: election.epoch,
                net_id: this.self.config.get('network.id')
            })).bytes;
            
            const sigData = await this.self.consensusKey.signRaw(signRaw)
            data.drain.push(sigData)
        }
    }

    async init() {
        this.electionDb = this.self.db.collection('election_results')
        this.mongoLogs = this.self.db.collection('logs')

        this.self.p2pService.multicastChannel.register('hold_election', this.handlePeerMsg, {
            loopbackOk: true
        })

        this.self.chainBridge.streamParser.addParser({
            priority: 'before',
            func: this.btHoldElection,
            type: 'block'
        })
        this.self.chainBridge.streamParser.addParser({
            name: 'electionMgr.index', 
            priority: 'before',
            func: this.btIndexElection,
            type: 'tx'
        })
    }
    

    async runTestCase() {
        const blk = 83303000
        const drift = blk % this.epochLength;
        const slotHeight = blk - drift
        const electionData = await this.generateElection(blk)
        
        const cid = await this.self.ipfs.dag.put(electionData)

        const electionHeader = {
            data: cid.toString(),
            epoch: electionData.epoch,
            net_id: this.self.config.get('network.id')
        }
        
        const signRaw = (await this.self.ipfs.dag.put(electionHeader)).bytes;
        console.log('signRaw - elector', signRaw, electionHeader)
        const circuit = new BlsCircuit({
            hash: signRaw
        })
        
        const {drain} = await this.self.p2pService.multicastChannel.call('hold_election', {
            mode: 'stream',
            payload: {
                block_height: blk
            },
            streamTimeout: 20_000
        })
        
        for await(let sigData of drain) {
            const pub = JSON.parse(Buffer.from(sigData.payload.p, 'base64url').toString()).pub
            const sig = sigData.payload?.s
            const verifiedSig = await circuit.verifySig({
                sig: sig,
                pub: pub,
            });
            console.log('aggregating the signature!', verifiedSig)
            if(verifiedSig) {
                await circuit.add({
                    did: pub,
                    sig
                })
            }
        }

        const members = await this.getMembersOfBlock(blk)
        const blocksSinceLastElection: number = todo('blocksSinceLastElection')
        const voteMajority = minimalRequiredElectionVotes(blocksSinceLastElection, members.length); //Hardcode for 0 until the future
        if(((circuit.aggPubKeys.size >= voteMajority) || electionHeader.epoch < 200)) {
            //Must be valid
            
            const electionResult = {
                ...electionHeader,
                signature: circuit.serialize(members.map(e => e.key))
                
            }
            // const electionResult = {
            //     "data": "bafyreiaaaokvwpkfvim2hafdfx2hsp2zdhih6hy2cr6sh2yuemi7zra4ou",
            //     "epoch": 0,
            //     "net_id": "testnet/0bf2e474-6b9e-4165-ad4e-a0d78968d20c",
            //     "signature": {
            //         "sig": "kiu6AMgpruGsc3xJNo53W4wj3xxgvRfsU6E6iADnodu79pOWsridipZzCtbgMzY6F6eC6qwuNLZeAcVNFeHYnmLp_gz4_RroZ8OUBNRgG5K3fMTsIZOb2ORmyq5ayE8L",
            //         "bv": "A9l-aJw"
            //     }
            // }
            
            const verifierCircuit = BlsCircuit.deserialize(electionResult, (await this.getMembersOfBlock(slotHeight)).map(e => e.key))
                const pubKeys: string[] = []
                for(let pub of circuit.aggPubKeys) {
                    pubKeys.push(pub[0])
                }

                //Aggregate pubkeys
                verifierCircuit.setAgg(pubKeys)

                console.log('aggs', pubKeys, pubKeys.length, verifierCircuit.did.id)

                const isValid = await verifierCircuit.verify((await this.self.ipfs.dag.put({
                    data: electionResult.data,
                    epoch: electionResult.epoch,
                    net_id: electionResult.net_id
                }, {
                    onlyHash: true
                })).bytes);
                const existingElectionResult = await this.electionDb.findOne({
                    epoch: electionResult.epoch,
                    net_id: electionResult.net_id
                })
                console.log('Validing election result', isValid)

                //Don't require 2/3 consensus for initial startup.
                const voteMajority = 2/3
                if(isValid && (((pubKeys.length / members.length) > voteMajority) || electionResult.epoch === 0)) {
                    //Must be valid
                    const fullContent = (await this.self.ipfs.dag.get(CID.parse(electionResult.data))).value


                    if(!existingElectionResult) {
                        await this.electionDb.findOneAndUpdate({
                            epoch: fullContent.epoch,
                            net_id: fullContent.net_id
                        }, {
                            $set: {
                                members: fullContent.members,
                                block_height: 5,
                                data: electionResult.data,
                                proposer: 'test',
                                signers: pubKeys
                            }
                        }, {
                            upsert: true
                        })
                    }
                }
        }
    }

    async start() {
        // await this.runTestCase()
    }
}
