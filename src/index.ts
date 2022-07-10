import { CoreService } from "./services"


async function startup(): Promise<void> {
  const core = new CoreService()
  await core.start()
  console.log(`startup`)
}

void startup()

process.on('unhandledRejection', (error: Error) => {
  console.log('unhandledRejection', error.message)
})
