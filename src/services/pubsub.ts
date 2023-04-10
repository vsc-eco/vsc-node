import NodeSchedule from 'node-schedule'
import { CID, IPFSHTTPClient } from "ipfs-http-client";
import * as Block from 'multiformats/block'
import * as codec from '@ipld/dag-cbor'
import { sha256 as hasher } from 'multiformats/hashes/sha2'
import { encode, decode } from '@ipld/dag-cbor'
import EventEmitter from 'events'
import PeerId from 'peer-id'
import KBucket from 'k-bucket'
import Crypto from 'crypto'
import { BloomFilter } from 'bloom-filters'
import jsonpatch from 'fast-json-patch';
import { Collection, ObjectId, WithId } from "mongodb";
import XorDistance from 'xor-distance'
// import { xor as uint8ArrayXor } from 'uint8arrays/xor'
import * as uint8ArrayXor from 'uint8arrays'
import { CoreService } from './index.js';
import pushable, { Pushable } from 'it-pushable';
import winston from 'winston';
import { getLogger, globalLogger } from '../logger.js';


enum PUBSUB_CHANNELS  {
    multicast = '/vsc/multicast',
    routesAnnounce = '/vsc/multicast'
}

enum MESSAGE_TYPES {
    announceNode = 'announce_node',
    directConnect = 'direct_connect'
}

enum VALID_EVENTS {
    registerPeer = "register_peer",
    unregisterPeer = "unregister_peer",
    connected = "connected",
    disconnected = "disconnected",
}

enum PEER_REASONS {
    ok = 200,
}

const DEFAULT_OPTIONS = {
    pollInterval: 1000,
    announceTimeout: 15 * 1000,
    //TODO to use
    annnounceMaxTimeout: 15 * 60 * 1000,
    announceMinTimeout: 1 * 60 * 1000
    
}

interface PeerInfo {
    peer_id: string
    latency: number | null
    distance: number
    routes_sent: number
    routes_recv: number
    ratio: number

    last_msg: Date
    first_msg: Date
    connected: boolean
}

type MessageHandleFn = (opts: {from: string, message: any, drain: Pushable<any>, sink: Pushable<any>}) => void

export class PeerChannel {
    ipfs: IPFSHTTPClient;
    topic: string;
    connectionAlive: boolean;
    target: string;
    events: EventEmitter;
    private interval: NodeJS.Timer;
    private _peers: string[];
    private _handles: Record<string, {
        id: string
        handler: MessageHandleFn
    }>;
    selfId: string;
    establishedTime: Date;
    logger: winston.Logger;
    constructor(ipfs: IPFSHTTPClient, topic: string, target: string) {
        this.logger = getLogger({
            prefix: 'peer channel',
            printMetadata: true,
            level: 'debug',
        })
        this.ipfs = ipfs;
        this.topic = topic;
        this.target = target;

        this.onMessageReceive = this.onMessageReceive.bind(this)

        this.connectionAlive = false;
        this._peers = []
        this._handles = {}
        this.establishedTime = new Date()
        
        this.events = new EventEmitter();
    }
    
    

    private async onMessageReceive(msg: any) {
        const raw_payload = Buffer.from(msg.data).toString()
        const json_payload = JSON.parse(raw_payload)
       
        if(msg.from === this.selfId) {
            //Ignore self
            return;
        }

        if(msg.from === this.target) {
            if(!this.connectionAlive) {
                this.connectionAlive = true;
                this.events.emit('connection_established')
            }
            this.logger.debug('received message', json_payload)
            if(json_payload.flags && json_payload.flags.includes('init')) {
                if(this._handles[json_payload.type]) {
                    let drain = pushable()
                    let sink = pushable()
                    void (async () => {
                        const events = this.events.on('message', (message) => {
                            //TODO make this feed the handler
                            if(json_payload.req_id === message.req_id) {
                                sink.push(message.payload)
                            }
                        })
                        this.logger.debug('peer events', events)
                        for await (let item of drain) {
                            this.logger.debug('Channel Response', item)
                            await this.send({
                                type: json_payload.type,
                                req_id: json_payload.req_id,
                                payload: item
                            })
                        }
                        await this.send({
                            type: json_payload.type,
                            req_id: json_payload.req_id,
                            flags: ['end']
                        })
                    })()
                    this._handles[json_payload.type].handler({from: msg.from, message: json_payload.message, drain, sink})
                }
            } else {
                await this.events.emit('message', {
                   from: msg.from,
                   type: json_payload.type, 
                   req_id: json_payload.req_id,
                   payload: json_payload.payload,
                   flags: json_payload.flags
                })
            }
            
        } else {
            this.logger.warn(`P2P: Expected ${this.target} but got ${msg.from}`)
        }
    }

    private async peerCheck() {
        
        const peerLs = (await this.ipfs.pubsub.peers(this.topic)).map(e => {
            return e.toString()
        });
        //console.log(peerLs)
        // console.log(jsonpatch)
        const differences = jsonpatch.compare(this._peers.map(p => p.toString()), peerLs.map(p => p.toString()))

        for(let itm of differences) {
            if(itm.op === "add") {
                // this.events.emit('peer joined', itm.value)
            }
            if(itm.op === "remove") {
                // this.events.emit('peer left', itm.)
            }
        }
        if(!this._peers.includes(this.target) && peerLs.includes(this.target)) {
            this.events.emit('peer joined', this.target)
            
        } else if(this._peers.includes(this.target) && !peerLs.includes(this.target)) {
            this.events.emit('peer left', this.target)
        } else {
            //Nothing
        }
        this._peers = peerLs
        /*differences.added.forEach((peer) => this.events.emit('peer joined', peer))
        differences.removed.forEach((peer) => this.events.emit('peer left', peer))
    
        return differences.added.length > 0 || differences.removed.length > 0&*/
    }

    private async send(msg: any) {
        await this.ipfs.pubsub.publish(this.topic, Buffer.from(JSON.stringify(msg)))
    }

    private async goodMorning() {
        await this.ipfs.pubsub.publish(this.topic, Buffer.from(JSON.stringify({
            type: "good_morning"
        })))
    }

    /**
     * 
     */
    private async goodNight() {
        await this.ipfs.pubsub.publish(this.topic, Buffer.from(JSON.stringify({
            type: "good_night"
        })))
        await this.ipfs.pubsub.unsubscribe(this.topic)
    }

    async end() {
        await this.goodNight()
        clearInterval(this.interval)
    }

    public async onMessage(type: string, handler: Function) {
        this.events.on('message', (data: any) => {
            if(data.type === type) {
                handler(data)
            }
        })
    }

    async init() {
        this.selfId = (await this.ipfs.id()).id.toString();
        await this.ipfs.pubsub.subscribe(this.topic, this.onMessageReceive)
        await this.goodMorning()

        this.interval = setInterval(() => {
            this.peerCheck()
        }, DEFAULT_OPTIONS.pollInterval)

        this.events.on('peer joined', (peer) => {
            this.logger.debug('peer joined', peer)
        })
    }

    async register(id: string, handler: MessageHandleFn) {
        this._handles[id] = {
            id,
            handler
        }
    }

    async call(id: string, options?: {
        payload: any,
        stream: Pushable<any>,
        mode?: "stream" | "basic"
    }): Promise<{
        drain: Pushable<any>
        req_id: string
        result: () => Promise<any>
    }> {
        const drain = pushable()
        const req_id = Crypto.randomBytes(8).toString('base64url');
        this.events.on('message', (msg) => {
            if(req_id === msg.req_id) {
                if(msg.flags && msg.flags.includes('end')) {
                    drain.end()
                } else {
                    drain.push(msg.payload)
                }
            }
        })
        await this.send({
            type: id,
            req_id,
            payload: options?.payload,
            flags: ['init']
        })
        
        return {
            result: async () => {
                let out = []
                for await(let item of drain) {
                    out.push(item)
                }
                if(out.length <= 1) {
                    return out[0]
                } else {
                    return out
                }
            },
            drain,
            req_id
        }
    }

    static async connect(ipfs: IPFSHTTPClient, target: string) {
        try {
            const block = await Block.encode({
                value: encode({
                    [(await ipfs.id()).id.toString()] : 'null',
                    [target]: 'null'
                }),
                codec,
                hasher,
            })
    
            globalLogger.info(`Initializing peer connection with ${target}`)
            const peerChannel = new PeerChannel(ipfs, `/p2p-direct/${block.cid}/vsc`, target)
            await peerChannel.init()

            return peerChannel
        } catch(ex) {
            console.log(ex)
        }

    }
}

export class P2PService {
    self: CoreService;
    directChannels: Record<string, PeerChannel>;
    directPeers: string[];
    peerDb: Collection<WithId<PeerInfo>>
    myPeerId: string;
    events: EventEmitter;

    constructor(self) {
        this.self = self;

        this.handleMulticast = this.handleMulticast.bind(this)
        this.announceNode = this.announceNode.bind(this)
        this.createDirectChannels = this.createDirectChannels.bind(this)

        this.directChannels = {}
        this.directPeers = []

        this.events = new EventEmitter();
    }
    

    private async handleMulticast(msg) {
        const msgTest = new Date();
        try {
            console.log('received announce', msg.from.toString())
            const raw_payload = Buffer.from(msg.data).toString()

            console.log(raw_payload)
            const json_payload = JSON.parse(raw_payload)
            if(msg.from.toString() === this.myPeerId) {
                return;
            }
            if(json_payload.type === MESSAGE_TYPES.announceNode) {
                this.self.logger.debug('multicast payload', json_payload)
                
                
                const nodeInfo = await this.peerDb.findOne({
                    peer_id: msg.from.toString()
                })

                const stt = new Date(json_payload.ts)
                console.log(stt, new Date(), msgTest)
                const message_drift = new Date().getTime() - stt.getTime()
                const latency = await this.getPeerLatency(msg.from)
                if(nodeInfo) {
                    await this.peerDb.findOneAndUpdate({
                        peer_id: msg.from.toString(),
                    }, {
                        $set: {
                            last_msg: new Date(),
                            message_drift,
                            latency
                        }
                    })
                } else {
                    const peer_id = msg.from
                    //console.log(peer_id.id, PeerId.parse(this.myPeerId).id)
                    
                    // const distance = uint8ArrayXor.xor(peer_id.id, PeerId.parse(this.myPeerId).id) 
                    console.log(peer_id, PeerId.parse(peer_id.toString()).id, PeerId.parse(this.myPeerId).id)
                    const distance2 = KBucket.distance(PeerId.parse(peer_id.toString()).id, PeerId.parse(this.myPeerId).id) 
                    //console.log(distance2, Math.log(distance2))
                    await this.peerDb.insertOne({
                        _id: new ObjectId(),
                        peer_id: msg.from.toString(),
                        distance: Math.log(distance2),
                        latency: latency,
                        first_msg: new Date(),
                        last_msg: new Date(),
                        routes_recv: 0,
                        routes_sent: 0,
                        ratio: null,
                        connected: false,
                    })
                }

            }

            if(json_payload.type === MESSAGE_TYPES.directConnect) {
                this.self.logger.debug('direct connected message payload', json_payload)
            }
        } catch(ex) {
            console.log(ex)
            this.self.logger.debug('error while handling multicast', ex)
        }
    }

    private async handleUnicast(msg) {
        try {
            const raw_payload = Buffer.from(msg.data).toString()

            const json_payload = JSON.parse(raw_payload)
            const peer = msg.from
            if(msg.from === this.myPeerId) {
                return;
            }

            if(json_payload.type === MESSAGE_TYPES.directConnect) {
                this.self.logger.info('Received unicast direct connect')
                if(!this.directPeers.includes(peer)) {
                    const channel = await PeerChannel.connect(this.self.ipfs, peer)
                    this.defaultRegister(channel)         
    
                    
    
                    const {result} = await channel.call('test')
    
                    this.self.logger.debug('Call Test Result', await result())
    
                    
                    await this.peerDb.findOneAndUpdate({
                        peer_id: peer
                    }, {
                        $set: {
                            connected: true
                        }
                    })
                    this.directPeers.push(peer)
                    this.self.logger.info(`Direct Peers ${JSON.stringify(this.directPeers)}`)
                }
            }
        } catch(ex) {
            this.self.logger.debug('error while handling unicast', ex)
        }
    }

    private defaultRegister(channel: PeerChannel) {
        channel.register('test', ({from, message, drain, sink}) => {
            this.self.logger.debug('test registration', {from, message, drain, sink})
            drain.push({
                "msg": "HELLO GOODMORNING TEST"
            })
            drain.end()
        })
        channel.register('node_info', ({from, message, drain, sink}) => {
            this.self.logger.debug('node info registration', {from, message, drain, sink})
            drain.push({
                agent: "VSC/1.0",
                motd: "Not set"
            })
            drain.end()
        })
    }

    async getPeerLatency(peerId: string) {
        
        let pingUnits = 0;
        let pingUnitsCount = 0 
        for await(let pingResult of this.self.ipfs.ping(PeerId.parse(peerId.toString()) as any)) {
            // console.log(pingResult)
            if(pingResult.text.includes('Average latency:')) {
                //Parse out latency
                const ping = pingResult.text.replace('Average latency: ', '')
                console.log(ping)
                console.log(Number(Number(ping.split('ms')[0]).toFixed(2)))
            } else if(!pingResult.text.includes('PING')) {
                pingUnitsCount = pingUnitsCount + 1;
                pingUnits = pingUnits + pingResult.time
            }
        }
        const pingMS = (pingUnits / pingUnitsCount) / 1_000_000
        return pingMS;
        // const peersResult = await this.self.ipfs.swarm.peers({
        //     latency: true
        // })
        // const result = peersResult.find(e => e.peer.toString() === peerId)
        // //console.log(peersResult, result)

        // // console.log(peersResult, result)
        // if(!result) {
        //     return;
        // }
        // if(result.latency.includes("µs")) {
        //     return 0;
        // } else {
        //     return Number(Number(result.latency.split('ms')[0]).toFixed(2))
        // }
    }

    async announceNode() {
        try {

            this.self.logger.info('Announcing node')
            const identity = await this.self.ipfs.id();
            const ts = new Date();
            
            const msg = {
                type: MESSAGE_TYPES.announceNode,
                id: (identity).id.toString(),
                ts,
                node_did: this.self.identity.id,
                payload: {
                    did_proof: await this.self.identity.createJWS({
                        peer_id: identity.id.toString(),
                        ts: ts.toISOString()
                    })
                }
            }
    
            const nodeInfo = {
                did_proof: await this.self.identity.createJWS({
                    peer_id: identity.id.toString(),
                    ts: ts.toISOString()
                })
            }
            await this.self.ipfs.pubsub.publish(PUBSUB_CHANNELS.multicast, Buffer.from(JSON.stringify(msg)))
    
            const nodeInfoCid = await this.self.ipfs.dag.put(nodeInfo)
    
            // console.log("Obj PsyOp", nodeInfoCid)
    
            await this.self.ipfs.name.publish(nodeInfoCid)
            

            console.log('Announced node done')
        } catch (ex) {
            console.log(ex)
        }
    }
    
    async createDirectChannels() {
        try {

            this.self.logger.info('Forming direct channels')
            const peersLs = await this.self.ipfs.pubsub.peers(PUBSUB_CHANNELS.multicast)
            const channelsLs = await this.self.ipfs.pubsub.ls()

            console.log(channelsLs, peersLs)
    
            for(let peer of peersLs) {
                if(!this.directPeers.includes(peer.toString())) {
                    const channel = await PeerChannel.connect(this.self.ipfs, peer.toString())
                    this.defaultRegister(channel)
    
                    
    
                    const {result} = await channel.call('node_info')
    
                    // console.log('Call Test Result', await result())
    
                    
                    //console.log(channel)
                    await this.peerDb.findOneAndUpdate({
                        peer_id: peer.toString()
                    }, {
                        $set: {
                            connected: true
                        }
                    })
                    this.directPeers.push(peer.toString())
                    this.self.logger.info(`Direct Peers ${JSON.stringify(this.directPeers)}`)
                }
            }
            
            if(peersLs[0]) {
                // const peer = PeerId.parse(peersLs[0])
                //console.log(peer.pubKey)
            }
        } catch (ex) {
            console.log(ex)
        }
    }
    
    async registerPeerManager(request: {
        handler: Function
    }) {

    }

    async registerHandle(request: {
        name: string
        version: string
        register: Function
        unregister: Function

    }) {

    }
    
    async setPeerMetadata(request: {
        memoryOnly: boolean
    }) {

    }

    async setMetadata(obj: Record<string, any>) {

    }

    async setMotd(msg: string, ttl?: number) {
        
    }

    async start() {
        this.self.logger.info('Starting Pubsub Interface')
        this.peerDb = this.self.db.collection('peers')
        this.myPeerId = (await this.self.ipfs.id()).id.toString()
        this.self.ipfs.pubsub.subscribe(PUBSUB_CHANNELS.multicast, this.handleMulticast)
        this.self.ipfs.pubsub.subscribe(`/p2p-uni/${this.myPeerId}`, this.handleUnicast)

        await this.peerDb.updateMany({}, {
            $set: {
                connected: false
            }
        })
        this.announceNode()
        // NodeSchedule.scheduleJob('*/15 * * * * ', this.announceNode)
        NodeSchedule.scheduleJob('* * * * * ', this.announceNode)
        // await this.createDirectChannels()
        // NodeSchedule.scheduleJob('* * * * * ', this.createDirectChannels)
    }
}