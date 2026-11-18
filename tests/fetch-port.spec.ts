import { describe, expect, it, vi } from 'vitest'
import { listenOnFetchPort } from './fixtures/fetch-port.ts'

describe('Fetch-safe test listener', () => {
  it('closes each blocked binding before trying again and keeps the accepted listener open', async () => {
    const operations: string[] = []
    const ports = [6000, 6668, 10080, 54000]
    const binding = await listenOnFetchPort(async () => {
      const port = ports.shift()!
      operations.push(`listen ${port}`)
      return { port }
    }, async ({ port }) => { operations.push(`close ${port}`) })

    expect(binding.port).toBe(54000)
    expect(operations).toEqual([
      'listen 6000', 'close 6000', 'listen 6668', 'close 6668', 'listen 10080', 'close 10080', 'listen 54000',
    ])
  })

  it('surfaces listener startup errors without retrying them', async () => {
    const error = new Error('listener failed')
    const listen = vi.fn().mockRejectedValue(error)
    const close = vi.fn()
    await expect(listenOnFetchPort(listen, close)).rejects.toBe(error)
    expect(listen).toHaveBeenCalledTimes(1)
    expect(close).not.toHaveBeenCalled()
  })
})
