/** The User Session Source: native messages in the single main Session, admitted through the normal Policy. */
import { z } from 'zod'
import { AllowedSchema, type Settings } from '../policy.ts'
import type { SourceKind } from './kind.ts'

/** Stable Source ID of the main Session entry. */
export const MAIN_SESSION_SOURCE = 'main-session'
/** The operator ID a fresh deployment allows and the entry uses until it is changed. */
export const DEFAULT_MAIN_SESSION_OPERATOR = 'dsh-user'

/**
 * Make the User Session Policy part follow its configured operator: the allowed list becomes exactly this operator,
 * keeping the display name already recorded for it. Used when the Source card saves and once at startup.
 */
export function syncMainSessionOperator(settings: Settings, operator: string): Settings {
  const current = settings.policy.sources[MAIN_SESSION_SOURCE]
  const name = current?.allowed.find(entry => entry.id === operator)?.name
  const entry = { ...current, allowed: [{ id: operator, ...(name ? { name } : {}) }], admission: current?.admission ?? {} }
  if (JSON.stringify(current) === JSON.stringify(entry)) return settings
  return { ...settings, policy: { ...settings.policy, sources: { ...settings.policy.sources, [MAIN_SESSION_SOURCE]: entry } } }
}

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
      zh: '主 Session 派单时使用的本地身份。保存时会自动把 Policy 的 allowed list 同步成这个标识；要停用，请用本卡片的 Source 开关。',
      en: 'Local identity used when the main Session dispatches. Saving syncs the Policy allowed list to this ID; use this card\'s Source switch to turn the entry off.',
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
        zh: '由 Source 卡片的 operator 自动同步，保存时名单只保留当前 operator。一般不需要手动编辑；要停用请用 Source 开关。',
        en: 'Synced from the Source card\'s operator; saving keeps only the current operator. Usually no manual edit is needed; use the Source switch to turn the entry off.',
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
