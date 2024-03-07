import { Collection } from "mongodb";
import Axios from 'axios'
import Moment from 'moment'
import { NewCoreService } from "..";
import { BlsCircuit } from "../utils/crypto/bls-did";
import networks from "../../../services/networks";
import { ParserFuncArgs } from "../utils/streamUtils";
import BitSet from "bitset";
import { CID } from "kubo-rpc-client";
import { HiveClient } from "../../../utils";
import { PrivateKey } from "@hiveio/dhive";
import { VersionConfig } from "./versionManager";


interface ElectionResult {
    block_height: number
    epoch: number
    members: Array<{
        account: string
        key: string
    }>
}


interface ElectionResultSignedHeader {
    epoch: number
    data: string
    signature: {
        sig: string
        bv: string
    }
}

function d2h(d) {
    var h = (d).toString(16);
    return h.length % 2 ? '0' + h : h;
}

function compressBV<T>(subset: Array<T>, set: Array<T>): string {
    const bs = new BitSet()
    for(let s of subset) {
        const n = set.indexOf(s);
        if(n !== -1) {
            bs.set(n, 1)
        }
    }
    return Buffer.from(d2h(bs.toString(16)), 'hex').toString('base64url');
}

function decompressBV<T>(bv: string, set: Array<T>): Array<T> {
    const bs = BitSet.fromHexString(Buffer.from(bv, 'base64url').toString('hex'))
    let result = []
    for(let keyIdx in bs) {
        if(bs.get(Number(keyIdx)) === 1) {
            result.push(set[keyIdx])
        }
    }

    return result;
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


/**
 * TODO: Dynamically adjust required weight IF election is stuck for more than 1 hour.
 */
function calcVotingWeight(drift: number) {
    return 2/3
}

interface LogEntry {
    service: string
    message: string
    ts: Date
    index_id: number
    version_id: string
}


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
    async getValidElectionOfblock(blkHeight: number) {
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

    //Gets valid members of N block height
    //Works across both 
    async getMembersOfBlock(blkHeight: number): Promise<Array<{account: string, key: string}>> {
        const election = await this.getValidElectionOfblock(blkHeight)
        if(election) {
            return election.members
        } else {
            const witnesses = await this.self.chainBridge.getWitnessesAtBlock(blkHeight);

            return witnesses.map(e => {
                return {
                    account: e.account,
                    key: e.keys.find(b => b.t === 'consensus').key
                }
            })
        }
    }

    /**
     * Generates a raw election graph from local data
     */
    async generateElection(blk: number) {
        const witnesses = await this.self.chainBridge.getWitnessesAtBlock(blk)
        const electionResult = await this.getValidElectionOfblock(blk - 1)

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
            topDates.push({
                tag: tag.tag,
                date: new Date(data.committer.date)
            })
        }
        
        const witnessList = witnesses.filter(e => {
            if(topDates[0]) {
                if(topDates[0].date.getTime() > Moment().subtract('12', 'hours').toDate().getTime() && e.version_id === topDates[1]?.tag) {
                    //Check if node is using the older update & hasn't updated (yet)
                    return true
                } else if(e.version_id === topDates[0].tag) {
                    //Node is updated!
                    return true;
                } else {
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
                key: e.keys.find(b => b.t === 'consensus').key
            }
        })

        const electionData = {
            __t: 'vsc-election',
            __v: '0.1',
            members: witnessList,
            //Iterate upon each successive consensus epoch
            epoch: electionResult ? electionResult.epoch + 1 : 0,

            // last_epoch: null,
            //For use when staking is active
            deposits: [],
            withdrawels: [],

            //net_id to prevent replay across testnets
            net_id: this.self.config.get('network.id')
        }
        
        return electionData;
    }

    async holdElection(blk:number) {
        const electionData = await this.generateElection(blk)
        
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

        const voteMajority = calcVotingWeight(0); //Hardcode for 0 until the future
        if((((circuit.aggPubKeys.size / members.length) < voteMajority) || electionHeader.epoch > 0)) {
            //Must be valid
            
            
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

    async btHoldElection({data:block}) {
        const blk = block.key
        const witnessSchedule = await this.self.witness.roundCheck(blk)
        const scheduleSlot = witnessSchedule.find(e => e.bn >= blk)
        // const drift = blk % this.epochLength;
        // const slotHeight = blk - drift
        if(scheduleSlot && scheduleSlot.account === process.env.HIVE_ACCOUNT) {
            if(blk % this.epochLength === 0 && this.self.chainBridge.parseLag < 5) {
                this.holdElection(blk)
            }
        }
    }

    async btIndexElection(args: ParserFuncArgs) {
        const {data} = args;

        const {tx, blkHeight} = data;

        let [op, opPayload] = tx.operations[0]

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
                let pubKeys = []
                for(let pub of circuit.aggPubKeys) {
                    pubKeys.push(pub[0])
                }

                const signedDataNoSig = json;
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

                //Don't require 2/3 consensus for initial startup.
                const voteMajority = 2/3
                if(isValid && (((pubKeys.length / members.length) < voteMajority) || json.epoch === 0)) {
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
                    } else {
                        await this.log(`Election result already exists for epoch ${json.epoch}`)
                    }
                } else {
                    await this.log(`Election result failed validation for epoch ${json.epoch}`, {
                        sig: json.signature.sig,
                        bv: json.signature.bv,
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
        const voteMajority = calcVotingWeight(0); //Hardcode for 0 until the future
        if((((circuit.aggPubKeys.size / members.length) < voteMajority) || electionHeader.epoch < 200)) {
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
                let pubKeys = []
                for(let pub of circuit.aggPubKeys) {
                    pubKeys.push(pub[0])
                }

                const signedDataNoSig = electionResult;
                delete signedDataNoSig.signature

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
                if(isValid && (((pubKeys.length / members.length) < voteMajority) || electionResult.epoch === 0)) {
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
