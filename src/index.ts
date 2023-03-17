import getLogger from "./logger";
import Logger from "./logger";
import { ApiModule } from "./modules/api/index"
import { CoreService } from "./services"

async function startup(): Promise<void> {
  const logger1 = getLogger('core1')
  const core = new CoreService({
    "debugHelper": {
        "nodePublicAdresses": ["did:key:z6MkqnJ2kvpaJCdVBgXH4jkaf95Yu5iJTnuarHw41wxxL5K5", "did:key:z6Mkofo9CvXkfTEr1twKpjWYvZqZzaEu4zT8gMATP6renNJg"]
    }
  }, logger1)
  await core.start()
  
  const api = new ApiModule(1337, core)
  await api.listen()
  
  // const logger2 = getLogger('core2')
  // const coreSeconday = new CoreService({
  //   dbSuffix: '1',
  //   pathSuffix: '1',
  //   ipfsApi: "/ip4/127.0.0.1/tcp/5002"
  // }, logger2)
  // await coreSeconday.start()
}

void startup()

process.on('unhandledRejection', (error: Error) => {
  console.log('unhandledRejection', error.message)
})
