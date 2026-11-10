/**
 * P2-A05: the Project PM tool boundary against DSH's real tool runtime. `tools.restrict` masks only inherited (global and
 * preset) tools and rejects a Session's own scope-local names, which is what broke PM Session creation on the real host.
 */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { bindScopeParent, createScope } from '@deepseek-ai/dsh-scope'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { expect, it } from 'vitest'
import { PM_TOOLS, pmToolBoundary } from '../src/app/sessions.ts'

/** A minimal tool the runtime accepts, used only to observe visibility and execution. */
function tool(name: string) {
  return defineTool({
    name, description: `The ${name} tool`,
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: true }, render: () => [{ type: 'text' as const, text: name }] },
    execute: async () => ({ name }),
  })
}

it('rejects PM tool names passed to tools.restrict, then keeps every inherited tool out and only PM tools callable', async () => {
  const ctx = new Context()
  ctx.reflect.provide('systemPrompt', { tools: () => {}, section: () => () => {} })
  const tools = new ToolRuntime(ctx)
  const presetKey = {}
  const preset = createScope(ctx, presetKey)
  // A global tool and a preset tool: what a PM would inherit without a boundary.
  tools.register(tool('read'))
  preset.ctx.tools.register(tool('bash'))
  const agent = { id: 'pm-project-1' } as unknown as Agent
  bindScopeParent(agent, presetKey)
  const scope = createScope(ctx, agent)
  ;(agent as unknown as { ctx: Context }).ctx = scope.ctx
  for (const name of PM_TOOLS) scope.ctx.tools.register(tool(name))
  try {
    // The exact failure seen on the real host: a PM tool is scope-local, so restrict cannot name it.
    expect(() => scope.ctx.tools.restrict({ allow: [PM_TOOLS[0]] })).toThrow(/names unknown global tool/)
    const disposers = pmToolBoundary(agent)
    try {
      // The boundary hides the global and preset tools the PM would otherwise see, and keeps its own four registrations.
      expect(scope.ctx.tools.schemas(agent).map(schema => schema.name).sort()).toEqual([...PM_TOOLS].sort())
      const signal = new AbortController().signal
      const inherited = await scope.ctx.tools.execute({ callId: 'bash' as never, name: 'bash', arguments: {}, agent, signal })
      expect(inherited.isError).toBe(true)
      expect(JSON.stringify(inherited)).toMatch(/A Project PM may use only/)
      const own = await scope.ctx.tools.execute({ callId: PM_TOOLS[0] as never, name: PM_TOOLS[0], arguments: {}, agent, signal })
      expect(own.isError).toBe(false)
      // A tool registered into the PM's own layer later is visible (restrict exempts a scope's own layer) but still denied.
      scope.ctx.tools.register(tool('leaked_local'))
      const leaked = await scope.ctx.tools.execute({ callId: 'leaked_local' as never, name: 'leaked_local', arguments: {}, agent, signal })
      expect(leaked.isError).toBe(true)
      expect(JSON.stringify(leaked)).toMatch(/A Project PM may use only/)
    } finally {
      for (const dispose of disposers) dispose()
    }
  } finally {
    await scope.dispose()
    await preset.dispose()
  }
})
