import { mkdtempSync, rmSync } from 'node:fs'
import { writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi, type Mock, type MockInstance } from 'vitest'
import { Commands } from '../src/infra/commands.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { admissionImageKeys, readAdmissionImage } from '../src/sources/feishu-image.ts'
import type { FeishuRef } from '../src/sources/feishu-read.ts'
import { imageTargetOf } from '../src/sources/image-target.ts'
import type { ImageAttachment, ImageAttachments, ImageModels, ImageTarget } from '../src/sources/kind.ts'

let directory: string
let target: ImageTarget
let saveImage: Mock<ImageAttachments['saveImage']>
let resolveModelInfo: Mock<ImageModels['resolveModelInfo']>
let lark: MockInstance<Commands['lark']>
const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
const source: FeishuRef = { triggerId: 'source', chatId: 'oc_chat', messageId: 'om_source' }
const text = '![Image](img_source) Plan mode'
const ref: ImageAttachment = { attachmentId: 'image-id', mediaType: 'image/png', bytes: 4, width: 1, height: 1 }
const signal = () => new AbortController().signal
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'admission-image-test-'))
  saveImage = vi.fn(async () => ref)
  resolveModelInfo = vi.fn(async () => ({ inputModalities: ['text', 'image'] }))
  // The narrow image port a SourceKind reads through, as the DSH boundary adapter builds it from the main Session.
  target = { attachments: { saveImage, imageLimits: { maxImageBytes: 100, maxMessageImageBytes: 100 } },
    llm: { resolveModelInfo }, provider: 'chosen-provider', model: 'chosen-model' }
  lark = vi.spyOn(Commands.prototype, 'lark').mockImplementation(async (args: string[], cwd?: string) => {
    expect(args).toEqual(['im', '+messages-resources-download', '--message-id', 'om_source', '--file-key', 'img_source', '--type', 'image', '--output', './image'])
    expect(cwd).toContain(directory)
    const saved_path = join(cwd!, 'image.png'); await writeFile(saved_path, 'data')
    return { saved_path }
  })
})
afterEach(() => { vi.restoreAllMocks(); rmSync(directory, { recursive: true, force: true }) })
it('retains the source-message pairing, commits an image reference and removes temporary files', async () => {
  expect(admissionImageKeys('![Image](img_source) {"image_key":"img_second"} img_source')).toEqual(['img_source', 'img_second'])
  expect(await readAdmissionImage(target, commands, source, text, 'img_source', directory, signal())).toEqual({ source_message_id: 'om_source', image_key: 'img_source', image: ref })
  expect(resolveModelInfo).toHaveBeenCalledWith('chosen-provider', 'chosen-model', expect.any(AbortSignal))
  expect(saveImage).toHaveBeenCalledWith({ data: Buffer.from('data'), mediaType: 'image/png', name: 'img_source.png' })
  expect(await readdir(directory)).toEqual([])
})
it('rejects arbitrary keys and non-visual models before downloading', async () => {
  await expect(readAdmissionImage(target, commands, source, text, '../img_other', directory, signal())).rejects.toThrow('source message')
  resolveModelInfo.mockResolvedValue({ inputModalities: ['text'] })
  await expect(readAdmissionImage(target, commands, source, text, 'img_source', directory, signal())).rejects.toThrow('does not support image')
  expect(lark).not.toHaveBeenCalled()
  expect(saveImage).not.toHaveBeenCalled()
})
it('cleans up refused attachments and failed downloads without returning an image', async () => {
  saveImage.mockRejectedValueOnce(new Error('Invalid image bytes'))
  await expect(readAdmissionImage(target, commands, source, text, 'img_source', directory, signal())).rejects.toThrow('Invalid image')
  expect(await readdir(directory)).toEqual([])
  lark.mockRejectedValueOnce(new Error('Resource permission denied'))
  await expect(readAdmissionImage(target, commands, source, text, 'img_source', directory, signal())).rejects.toThrow('permission denied')
  expect(await readdir(directory)).toEqual([])
})
it('refuses escaped output paths, oversize files and unsupported types', async () => {
  const outside = join(directory, 'outside.png'); await writeFile(outside, 'data')
  lark.mockResolvedValueOnce({ saved_path: outside })
  await expect(readAdmissionImage(target, commands, source, text, 'img_source', directory, signal())).rejects.toThrow('outside')
  for (const [name, bytes, error] of [['image.png', 101, 'byte limit'], ['image.svg', 4, 'supported']] as const) {
    lark.mockImplementationOnce(async (_args, cwd) => {
      const saved_path = join(cwd!, name); await writeFile(saved_path, Buffer.alloc(bytes)); return { saved_path }
    })
    await expect(readAdmissionImage(target, commands, source, text, 'img_source', directory, signal())).rejects.toThrow(error)
  }
  expect(saveImage).not.toHaveBeenCalled()
  expect(await readdir(directory)).toEqual(['outside.png'])
})
it('still refuses an image without an attachment service, a model service or a resolved route', async () => {
  await expect(readAdmissionImage({}, commands, source, text, 'img_source', directory, signal()))
    .rejects.toThrow('no attachment service is mounted')
  await expect(readAdmissionImage({ attachments: target.attachments }, commands, source, text, 'img_source', directory, signal()))
    .rejects.toThrow('current model route is unresolved')
  await expect(readAdmissionImage({ llm: target.llm, provider: 'chosen-provider', model: 'chosen-model' }, commands, source, text,
    'img_source', directory, signal())).rejects.toThrow('no attachment service is mounted')
  expect(lark).not.toHaveBeenCalled()
})
it('narrows a live Agent to the image port, preferring its latest request route over the selected options', () => {
  const attachments = target.attachments
  const llm = target.llm
  const agent = (header?: { config: { provider: string; model: string } }) => ({
    ctx: { get: (name: string) => name === 'attachments' ? attachments : name === 'llm' ? llm : undefined },
    session: { requestHeader: () => header },
    options: { provider: 'selected-provider', model: 'selected-model' },
  })
  expect(imageTargetOf(agent({ config: { provider: 'header-provider', model: 'header-model' } })))
    .toEqual({ attachments, llm, provider: 'header-provider', model: 'header-model' })
  expect(imageTargetOf(agent())).toEqual({ attachments, llm, provider: 'selected-provider', model: 'selected-model' })
})
