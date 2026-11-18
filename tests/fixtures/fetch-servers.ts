import { ControlPlaneServer } from '../../src/control/server.ts'
import { startControlPlane } from '../../src/control/start.ts'
import { startNodeHttpServer } from '../../src/node/http-server.ts'
import { listenOnFetchPort } from './fetch-port.ts'

/** Run the production HTTP handlers with a Fetch-compatible ephemeral listener. */
export class FetchControlPlaneServer {
  private server: ControlPlaneServer
  private readonly args: ConstructorParameters<typeof ControlPlaneServer>

  constructor(...args: ConstructorParameters<typeof ControlPlaneServer>) {
    this.args = args
    this.server = new ControlPlaneServer(...args)
  }

  listen(port = 0): ReturnType<ControlPlaneServer['listen']> {
    if (port !== 0) return this.server.listen(port)
    return listenOnFetchPort(() => this.server.listen(0), async () => {
      await this.server.close()
      this.server = new ControlPlaneServer(...this.args)
    })
  }

  close(): Promise<void> {
    return this.server.close()
  }
}

export function startFetchNodeServer(options: Parameters<typeof startNodeHttpServer>[0]): ReturnType<typeof startNodeHttpServer> {
  if (options.port) return startNodeHttpServer(options)
  return listenOnFetchPort(() => startNodeHttpServer(options), binding => binding.close())
}

export async function startFetchControlPlane(options: Parameters<typeof startControlPlane>[0]): ReturnType<typeof startControlPlane> {
  const binding = await listenOnFetchPort(async () => {
    const running = await startControlPlane(options)
    return { running, port: running.address.port }
  }, ({ running }) => running.close())
  return binding.running
}
