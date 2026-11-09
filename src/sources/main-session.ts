/** The User Session Source: native messages in the single main Session, admitted through the normal Policy. */
import { z } from 'zod'
import { AllowedSchema } from '../policy.ts'
import type { SourceKind } from './kind.ts'

/** Stable Source ID of the main Session entry. */
export const MAIN_SESSION_SOURCE = 'main-session'
/** The operator ID a fresh deployment allows and the entry uses until it is changed. */
export const DEFAULT_MAIN_SESSION_OPERATOR = 'dsh-user'

const ConfigSchema = z.object({
  /** The local operator the main Session acts as; the Policy's allowed list must contain this ID. */
  operator: z.string().trim().min(1).max(200).default(DEFAULT_MAIN_SESSION_OPERATOR),
}).strict()
export type MainSessionConfig = z.infer<typeof ConfigSchema>

/**
 * A built-in Source kind for requests typed in the main Session. It produces no polls and no Channel: the main
 * Session tool registers one Trigger per explicit dispatch, and the normal gate decides whether its operator may
 * originate work. The Source only supplies the operator identity, the settings card and the Policy part.
 */
export const mainSessionKind: SourceKind<MainSessionConfig> = {
  kind: MAIN_SESSION_SOURCE,
  title: { zh: '用户会话', en: 'User Session' },
  description: {
    zh: '主 Session 里的本机操作者请求。它不是轮询来源：主 Session 明确派工时登记一条 Trigger，再由 Policy 判断操作者能否发起。',
    en: 'Requests from the local operator in the main Session. It does not poll: the main Session registers one Trigger when it explicitly dispatches, and the Policy decides whether that operator may originate work.',
  },
  schema: ConfigSchema,
  fields: [{
    key: 'operator',
    type: 'text',
    label: { zh: '操作者标识', en: 'Operator ID' },
    hint: {
      zh: '主 Session 派单时使用的本地身份。必须同时出现在 Policy 的“能发起工作的用户会话操作者”名单里；改这里后要同步改名单。',
      en: 'Local identity used when the main Session dispatches. It must also appear in the Policy list of User Session operators allowed to originate work; changing it here needs the matching list change.',
    },
  }],
  health: [],
  /** The registry turns an off instance into `source_disabled`; an on instance is always listened to. */
  scope: () => ({ listened: true, observed: false }),
  policy: {
    schema: z.object({ allowed: z.array(AllowedSchema).default([]) }).strict(),
    fields: [{
      key: 'allowed',
      type: 'rows',
      label: { zh: '能发起工作的用户会话操作者', en: 'User Session operators who may originate work' },
      hint: {
        zh: '只有这里的标识能在主 Session 里登记派工请求。默认包含 dsh-user；改 Source 卡片的操作者标识时，也要在这里加同一个标识。',
        en: 'Only these IDs may register dispatch requests from the main Session. dsh-user is included by default; when the Source card changes its operator ID, add the same ID here.',
      },
      columns: [{ key: 'id', type: 'text', label: { zh: '标识', en: 'ID' } },
        { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }],
    }],
    explicit: {
      zh: '配置的操作者标识在主 Session 里明确要求派工。',
      en: 'The configured operator explicitly asks for work in the main Session.',
    },
  },
}
