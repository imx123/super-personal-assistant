import type { Server } from 'node:http'

// https://fetch.spec.whatwg.org/#port-blocking
const blockedPorts = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
  101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179,
  389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601,
  636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566,
  6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
])

/** Bind the actual fixture before checking the port so no other process can take an accepted port. */
export async function listenOnFetchPort<T extends { port: number }>(
  listen: () => Promise<T>, close: (binding: T) => Promise<void>,
): Promise<T> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const binding = await listen()
    if (!blockedPorts.has(binding.port)) return binding
    await close(binding)
  }
  throw new Error('Could not bind an ephemeral HTTP port allowed by Fetch')
}

export function listenFetchLoopback(server: Server): Promise<{ url: string; port: number }> {
  return listenOnFetchPort(() => new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      const address = server.address()
      if (address === null || typeof address === 'string') return reject(new Error('HTTP fixture has no TCP address'))
      resolve({ port: address.port, url: `http://127.0.0.1:${address.port}` })
    })
  }), () => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
  }))
}
