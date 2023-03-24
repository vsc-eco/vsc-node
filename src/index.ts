import getLogger from "./logger";
import Logger from "./logger";
import { ApiModule } from "./modules/api/index"
import { CoreService } from "./services"

async function startup(): Promise<void> {
  
  const core = new CoreService({
    debugHelper: {
        nodePublicAdresses: ["did:key:z6MkqnJ2kvpaJCdVBgXH4jkaf95Yu5iJTnuarHw41wxxL5K5", "did:key:z6Mkofo9CvXkfTEr1twKpjWYvZqZzaEu4zT8gMATP6renNJg"],
        serviceName: "main"
    }
  })
  await core.start()
  
  const api = new ApiModule(1337, core)
  await api.listen()
  
  // const coreSeconday = new CoreService({
  //   dbSuffix: '1',
  //   pathSuffix: '1',
  //   ipfsApi: "/ip4/127.0.0.1/tcp/5002",
  //   debugHelper: {
  //     serviceName: "secondary"
  //   }
  // })
  // await coreSeconday.start()
}

void startup()

process.on('unhandledRejection', (error: Error) => {
  console.log('unhandledRejection', error.message)
})
