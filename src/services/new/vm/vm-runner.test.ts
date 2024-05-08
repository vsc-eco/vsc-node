
import { fileURLToPath } from 'url';
import path, { dirname } from 'path';
import fs from 'fs/promises'
import asc from "assemblyscript/dist/asc";
import * as IPFS from 'kubo-rpc-client'
import {fork} from 'child_process'
import Crypto from 'crypto'
import { VmContainer } from './utils';
import { sleep } from '../../../utils';
import { bech32 } from 'bech32';
import 'dotenv/config'


const ipfs = IPFS.create({url: process.env.IPFS_HOST || 'http://127.0.0.1:5001'})
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TESTS: {
  script: string;
  action: string;
  payload: string;
  state: string | Promise<string>;
}[] = [
  // {
  //   script: 'script.tsa',
  //   action: 'testJSON',
  //   payload: JSON.stringify({
  //     to: "test1",
  //     from: 'test2',
  //   }),
  //   state: (async () => (await ipfs.object.new({template: 'unixfs-dir'})).toString())(),
  // },
  {
    script: 'envScript.tsa',
    action: 'dumpEnv',
    payload: 'dc710d0ff7c90353549a739c4dbf6ac3ac02ef74',
    state: 'QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn',
  },
]

void (async () => {
    for (const test of TESTS) {
        const scriptPath = path.join(__dirname, test.script)


        

        var stdout = asc.createMemoryStream();
        const compileResult = await asc.main([
          'input.ts',
          // "-b",
          "-o",
          "--optimize",
          "--Osize",
          "--exportRuntime",
          '--runPasses',
          "asyncify"
        ], {
          stdout: stdout,
          readFile: async (filename: string, baseDir: string) => {
            // console.log(filename, baseDir) 
            try {
              if(filename === 'input.ts') {
                return (await fs.readFile(scriptPath)).toString()
              }
              return (await fs.readFile(filename)).toString()
            } catch {
              return null
            }
          }
        });

        
        if(compileResult.error) {
            console.log(compileResult.error)
            console.log(compileResult.stderr.toString())
            return;
        }

        try {
          const binary = stdout.toBuffer()


          // const cid = await ipfs.dag.put(binary)
          const cid = IPFS.CID.parse('bafyreihmqkn5sql6zts7rpgf7iwuatpb4yj3tpw2gx7akpsucawy2hlbwm')
          console.log(cid)

          const vmContainer = new VmContainer({
            state: {
              'vs41q9c3yg82k4q76nprqk89xzk2n8zhvedrz5prnrrqpy6v9css3seg2q43uvjdc500': await test.state,
            },
            modules: {
              'vs41q9c3yg82k4q76nprqk89xzk2n8zhvedrz5prnrrqpy6v9css3seg2q43uvjdc500': cid.toString()
            },
            debug: true,
            // timeout: 100
          })

          await vmContainer.init()
          await vmContainer.onReady()


          for(let x = 0; x < 1; x++) {
            const result = await vmContainer.call({
              contract_id: "vs41q9c3yg82k4q76nprqk89xzk2n8zhvedrz5prnrrqpy6v9css3seg2q43uvjdc500",
              action: test.action,
              payload: test.payload,
              env: {
                'anchor.id': 'bafyreihyjk3olkn4rciurxidixdpsl7lwofngqqe3zgjzxmxu3depwekry',
                'anchor.block': '05087e19a52eba1a0dbeeaa95ef08a1eaf64a26e',
                //Anchor height on chain
                'anchor.height': 84442649,
                //Timestamp in epoch ms
                //It should always be 000 for ms offset as blocks are produced exactly in 3 second intervals
                'anchor.timestamp': 1_711_589_394_000,
                //Hive account, or DID or contract address or smart address
                'tx.origin': 'hive:testaccount',
                'msg.sender': 'hive:testaccount',
                'msg.required_auths': ['hive:testaccount'],
              }
            })
            console.log(result)
          }    
              
          for await(let it of vmContainer.finishIterator()) {
            console.log(it)
          }
          await vmContainer.finish()

        } catch(ex) {
          console.log(ex)
        }
    }

    // await sleep(5_000)

    process.exit(0)

    let reqId;
    let startTime
    // child.on('message', (message: any) => {
    //     if(message.type === "ready") {
    //         reqId = Crypto.randomBytes(6).toString('base64url')
    //         startTime = new Date();
    //         console.log('startTime', startTime)
    //         const payload = JSON.stringify({
    //             to: "test1",
    //             from: 'test2',
    //         })
    //         child.send({
    //             type: "call",
    //             action: "testJSON",
    //             payload,
    //             reqId
    //         });
    //     }
    //     if(message.reqId === reqId) {
    //         console.log(message, new Date().getTime() - startTime.getTime(), new Date())
    //         reqId = Crypto.randomBytes(6).toString('base64url')
    //         startTime = new Date();
    //       //   const payload = JSON.stringify({
    //       //     to: "test1",
    //       //     from: 'test2',
    //       //   })
    //       //   child.send({
    //       //     type: "call",
    //       //     action: "testJSON",
    //       //     payload,
    //       //     reqId
    //       // });
    //     }
    // });
})()