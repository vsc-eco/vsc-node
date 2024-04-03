import { ApiModule } from "./modules/api/index"
import { CoreService } from "./services"
import { NewCoreService } from "./services/new";

async function startup(): Promise<void> {
  
  const coreNew = new NewCoreService();
  const core = new CoreService({
    newService:coreNew
  })
  await core.start()

  await coreNew.init(core)
  await coreNew.start()
  
  const api = new ApiModule(1337, core)
  await api.listen()


  const cleanup = async (code: number) => {
    await core.stop()
    await coreNew.stop()
    await api.stop()
    process.exit(code)
  };

  process.on("SIGINT", () => cleanup(0));
  process.on("SIGTERM", () => cleanup(0));
  process.on("beforeExit", cleanup);
}

void startup()

process.on('unhandledRejection', (error: Error) => {
  console.log('unhandledRejection', error)
})
