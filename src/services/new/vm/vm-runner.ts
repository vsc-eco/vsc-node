import * as IPFS from 'kubo-rpc-client'
import { addLink } from '../../../ipfs-utils/add-link'
import { removeLink } from '../../../ipfs-utils/rm-link'
import { instantiate } from './utils'
const CID = IPFS.CID

const ipfs = IPFS.create({ url: 'http://127.0.0.1:5001' })


export class WasmRunner {
  stateCache: Map<string, any>
  constructor() {
    this.stateCache = new Map()
  }

  async contractStateRaw(id: string, stateMerkle?: string) {
    let stateCid
    // let contract = await this.contractDb.findOne({
    //   id,
    // })
    const contract = {} as any
    if (!contract) {
      throw new Error('Contract Not Indexed Or Does Not Exist')
    }
    if (contract) {
      if (stateMerkle) {
        stateCid = CID.parse(stateMerkle)
      } else {
        if (contract.state_merkle) {
          stateCid = CID.parse(contract.state_merkle)
        } else {
          stateCid = CID.parse('QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn')
        }
      }
    }

    return {
      client: {
        /**
         *
         * @param id Contract ID
         */
        remoteState: async (id: string) => {
          const state = await this.contractStateRaw(id)

          return {
            pull: state.client.pull,
            ls: state.client.ls,
          }
        },
        pull: async (key: string) => {
          try {
            console.log(stateCid)
            const out = await ipfs.dag.resolve(stateCid, {
              path: key,
            })

            const data = await ipfs.dag.get(out.cid)

            console.log(data)
            if (out.cid.code === 0x70) {
              //If accidentally requesting PD-dag
              const out = await ipfs.dag.resolve(stateCid, {
                path: `${key}/.self`,
              })

              const data = await ipfs.dag.get(out.cid)
              return data.value
            } else if (out.cid.code === 0x71) {
              //CBOR dag
              return data.value
            } else {
              //This shouldn't happen unless other issues are present.
              return null
            }
          } catch (ex) {
            console.log(ex)
            return null
          }
        },
        update: async (key, value: any) => {
          try {
            if (!value) {
              return
            }
            let merkleCid = stateCid

            let linkExists
            let dagData
            let brokenPaths = []
            try {
              const resolvedCid = await ipfs.dag.resolve(merkleCid, {
                path: key,
              })

              const rawData = await ipfs.dag.get(resolvedCid.cid)
              if (resolvedCid.cid.code === 0x70) {
                dagData = JSON.parse(Buffer.from(rawData.value.Data).toString())
              } else if (resolvedCid.cid.code === 0x71) {
                dagData = rawData.value
              }
            } catch (ex) {
              linkExists = false
              let splitKey = key.split('/')
              for (let x = 0; x < splitKey.length; x++) {
                let partialKey = splitKey.slice(0, splitKey.length - 1 - x)
                console.log(partialKey)

                try {
                  const cid = await ipfs.dag.resolve(merkleCid, {
                    path: partialKey.join('/'),
                  })
                  console.log(cid.cid.code)
                  if (cid.cid.code === 0x70) {
                    break
                  } else {
                    brokenPaths.push({
                      path: partialKey.join('/'),
                      cid: cid.cid,
                      wrongFormat: true,
                    })
                  }
                } catch {
                  brokenPaths.push({ path: partialKey.join('/') })
                }
              }
            }

            for (let brokenPath of brokenPaths.reverse()) {
              if (brokenPath.wrongFormat) {
                merkleCid = await ipfs.object.patch.addLink(merkleCid, {
                  Name: brokenPath.path,
                  Hash: CID.parse('QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn'),
                })

                merkleCid = await ipfs.object.patch.addLink(merkleCid, {
                  Name: `${brokenPath.path}/.self`,
                  Hash: brokenPath.cid,
                })
              } else {
                merkleCid = await ipfs.object.patch.addLink(merkleCid, {
                  Name: brokenPath.path,
                  Hash: CID.parse('QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn'),
                })
              }
            }

            const dataCid = await ipfs.dag.put(value)
            const stat = await ipfs.block.stat(dataCid)

            merkleCid = (
              await addLink(ipfs, {
                parentCid: merkleCid,
                name: key,
                size: stat.size,

                cid: dataCid,
                hashAlg: 'sha2-256',
                cidVersion: 1,
                flush: true,
                shardSplitThreshold: 2_000,
              })
            ).cid

            stateCid = merkleCid
          } catch (ex) {
            console.log(ex)
          }
          //TODO make this happen after contract call has been completely executed
          //stateCid = obj;
        },
        /**
         * WIP: needs DAG type updates
         * @param key
         * @returns
         */
        ls: async (key) => {
          try {
            const pBufNode = await ipfs.object.get(`${stateCid}/${key}` as any)
            console.log(pBufNode.Links)
            return pBufNode.Links.map((e) => e.Name)
          } catch {
            return []
          }
        },
        del: async (key) => {
          if (!key) {
            return
          }
          let merkleCid = stateCid
          //To be implemented!
          merkleCid = await removeLink(ipfs, {
            parentCid: merkleCid,
            name: key,
            size: 0,

            hashAlg: 'sha2-256',
            cidVersion: 1,
            flush: true,
            shardSplitThreshold: 2_000,
          })
          stateCid = merkleCid
        },
      },
      finish: () => {
        return {
          stateMerkle: stateCid,
        }
      },
      startMerkle: stateCid,
    }
  }

  async initiate() {}

  async testRun() {}

  registerBindings() {}
}

void (async () => {
  
  const contract_id = process.env.contract_id
  
  const binaryData = await ipfs.block.get(IPFS.CID.parse(process.env.cid))
  
  const wasmRunner = new WasmRunner();
  const stateAccess = await wasmRunner.contractStateRaw(contract_id)
  
  const module = await WebAssembly.compile(binaryData)
  
  process.send({
    type: 'ready',
  })
  process.on('message', async (message: any) => {
    if (message.type === 'call') {
      const memory = new WebAssembly.Memory({
        initial: 10,
        maximum: 128,
      })
      
      let IOGas = 0;

      const logs = []
      const insta = await instantiate(module, {
        env: {
          memory,
        },
        input: {
          'console.log': (keyPtr) => {
            const logMsg = insta.exports.__getString(keyPtr)
            logs.push(logMsg)
            IOGas = IOGas + logMsg.length
          },
          'console.logNumber': (val) => {
            logs.push(val)
          },
          'console.logBool': (val) => {
            logs.push(Boolean(val))
          },
          'state.setObject': (keyPtr, valPtr) => {
            const key = insta.exports.__getString(keyPtr)
            const val = insta.exports.__getString(valPtr)
            
            IOGas = IOGas + key.length + val.length

    
            wasmRunner.stateCache.set(key, val)
            return 1
          },
          'state.getObject': async (keyPtr) => {
            const key = insta.exports.__getString(keyPtr)
            let value;
            if(wasmRunner.stateCache.has(key)) {
              value = wasmRunner.stateCache.get(key)
            } else {
              value = await stateAccess.client.pull(key)
              wasmRunner.stateCache.set(key, value)
            }

            const val = JSON.stringify(value)
            
            IOGas = IOGas + val.length; // Total serialized length of gas


            return val
          },
        },
      } as any)
      

      


      console.log('message from parent:', message, new Date(), new Date().getTime())
      const ptr = await (insta.instance.exports[message.action] as any)(
        insta.exports.__newString(message.payload),
      )
      const str =  insta.exports.__getString(ptr)
      process.send({
        type: 'execute-stop',
        result: str,
        logs,
        reqId: message.reqId,
        IOGas,
      })
      
      console.log('message to parent:', message, new Date(), new Date().getTime())
      console.log('logs', logs, 'result', str)
      // process.send({
      //   type: 'result',
      //   result: str,
      //   reqId: message.reqId,
      // })
    }
    if(message.type === "finish") {
      for(let [key, value] of wasmRunner.stateCache.entries()) {
        await stateAccess.client.update(key, JSON.parse(value))
      }
      console.log(stateAccess.finish())
      process.send({
        type: 'result',
        result: stateAccess.finish().stateMerkle.toString(),
      })
    }
  })
})()