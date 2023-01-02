import 'dotenv/config'
import * as IPFS from "ipfs-http-client";
import { IPFSHTTPClient } from "ipfs-http-client";
import Path from 'path'
import os from 'os'
import Crypto from 'crypto'

import { Ed25519Provider } from "key-did-provider-ed25519";
import { DID } from "dids";
import KeyResolver from 'key-did-resolver'
import { Config } from "../services/nodeConfig";

const homeDir = Path.join(os.homedir(), '.vsc-node')

let identity = null;

export async function init() {
    const config = new Config(homeDir)
    await config.open()

    const privateKey = config.get('identity.walletPrivate');
    if(!privateKey) {
        throw new Error("No identity found. Please initial a daemon")
    }
    if(!process.env.HIVE_ACCOUNT_POSTING || !process.env.HIVE_ACCOUNT_POSTING) {
        throw new Error("No HIVE account found in .env file")
    }
    const keyPrivate = new Ed25519Provider(Buffer.from(privateKey, 'base64'))
    const identity = new DID({ provider: keyPrivate, resolver: KeyResolver.getResolver() })
    await identity.authenticate()
    console.log("Logged In With", identity.id, `and ${process.env.HIVE_ACCOUNT}`)

    return {
        identity,
        config
    }
}