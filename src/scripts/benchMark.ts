import { HiveClient, streamHiveBlocks } from "../utils"


 
const HIVE_APIS = [
  'hive-api.web3telekom.xyz',
  'api.shmoogleosukami.co.uk',
  "hive-api.3speak.tv",
  "api.hive.blog",
  "api.openhive.network",
  "rpc.ausbit.dev",
  "techcoderx.com",
  "hived.emre.sh",
  "api.deathwing.me",
  "api.c0ff33a.uk"
]

const REQUESTED_STEPS = [10, 25, 50, 150, 300, 500, 600, 800, 1000]


void (async () => {
  const currentBlock = await HiveClient.blockchain.getCurrentBlockNum()
  
  let start_block = 74869131;
  let measures = []
  for(let api of HIVE_APIS) {
    try {
        const date = new Date()
        const blist = await streamHiveBlocks(`https://${api}`, {
          start_block: start_block,
          count: 10
        })

        const lag_ms = new Date().getTime() - date.getTime();
        measures.push({
          lag_ms, api
        })
        
        // console.log(`${new Date().getTime() - date.getTime()}ms`, blist.length, start_block, Math.round((start_block / currentBlock) * 1000) / 10, "%")
      } catch (ex) {
        console.log(ex)
      }
  
  }
  console.log(measures.sort((a, b) => {
    return a.lag_ms - b.lag_ms
  }))
  measures = measures.sort((a, b) => {
    return a.lag_ms - b.lag_ms
  })

  let x = 0;
  for(let {api} of measures) {
    let testedSteps = []
    for(let STEP of REQUESTED_STEPS) {
      try {
        const date = new Date()
        await streamHiveBlocks(`https://${api}`, {
          start_block: start_block,
          count: STEP
        })
        const lag_ms = new Date().getTime() - date.getTime();
        if(lag_ms > 6000) {
          break;
        }
        testedSteps.push([lag_ms, STEP])
      } catch {
        break;
      }
      measures[x].testedSteps = testedSteps
    }
    x = x + 1;
  }
  console.log(JSON.stringify(measures, null, 1))
})()