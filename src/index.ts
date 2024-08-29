import { ApiModule } from "./modules/api/index"
import { CoreService } from "./services"
import { NewCoreService } from "./services/new";
import telemetry from "./telemetry";
import express from 'express';
import { register, Counter } from 'prom-client';

async function startup(): Promise<void> {
  telemetry.start()
  
  const coreNew = new NewCoreService();
  const core = new CoreService({
    newService:coreNew
  })
  await core.start()

  await coreNew.init(core)

  // consensusKey initialized in coreNew.init()
  telemetry.setUserId(coreNew.consensusKey.id, process.env.HIVE_ACCOUNT)

  await coreNew.start()
  
  const api = new ApiModule(1337, core)
  await api.listen()

  const httpRequestCounter = new Counter({
    name: 'http_requests_total',
    help: 'Total number of HTTP requests',
  });
  httpRequestCounter.inc();
  const promMetrics = express();

  promMetrics.get('/metrics', async (req, res) => {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  });

  setTimeout(() => {  
    promMetrics.listen(3001, () => {
      console.log('Server is running on port 3001');
    });
  }, 1);

  const cleanup = async (code: number) => {
    await core.stop()
    await coreNew.stop()
    await api.stop()
    await telemetry.stop()
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
