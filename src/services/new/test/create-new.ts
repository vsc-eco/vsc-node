import { Ed25519Provider } from "key-did-provider-ed25519";
import { DID } from "dids";
import KeyResolver from 'key-did-resolver'
import Crypto from 'crypto'
import { BlockHeader } from "../types";
import { CID, create } from "kubo-rpc-client";
import { ChainBridgeV2 } from "../chainBridgeV2";

void (async () => {
    const ipfs = create({url:'http://127.0.0.1:5001'})
    const keyPrivate = new Ed25519Provider(Crypto.randomBytes(32))
    const did = new DID({ provider: keyPrivate, resolver: KeyResolver.getResolver() })
    await did.authenticate()

    const block: BlockHeader = {
        
        block: CID.parse('bafybeidme3hjw2ja7ofter7pwjmfbf4l72kmtnnhxh3hfq4ekby54ngsqi'),
        previous: CID.parse('bafybeidme3hjw2ja7ofter7pwjmfbf4l72kmtnnhxh3hfq4ekby54ngsqi'),
        required_auths: [{
            type: 'consensus',
            value: 'vsc.node1'
        }],
    }


    block['signatures'] = (await did.createJWS(block)).signatures
    console.log(block, (await did.createDagJWS(block)).jws.signatures)
    const cid = await ipfs.dag.put(block)
    console.log(await ipfs.block.stat(cid))

    const chainBridge = new ChainBridgeV2()
    await chainBridge.init()
    await chainBridge.start()
})()