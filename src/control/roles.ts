/** Role profiles the control plane hands to a node. The tool names mirror the current DSH deployment. */
import type { RoleProfile } from '../shared/protocol.ts'

/** A Project PM sees its Project and its Tickets, but no shell or file write tools. */
export const PM_PROFILE = {
  name: 'pm.v1',
  prompt: 'You manage one Project. Use control_project to read this Project and its Tickets, and control_create_tickets to '
    + 'create Tickets in it. Decide handoffs, report on the Project, and do not edit files.',
  tools: [
    'orchestrator_read',
    'orchestrator_project_report',
    'orchestrator_project_ticket_create',
    'orchestrator_project_ticket_message',
    'orchestrator_project_ticket_revive',
    'orchestrator_project_ticket_handoff',
    'orchestrator_project_ticket_handoff_new_ticket',
    'orchestrator_project_ticket_handoff_to_project',
    'orchestrator_project_ticket_handoff_decide',
    'control_project',
    'control_create_tickets',
  ],
  deny: ['write', 'edit', 'bash', 'pwsh', 'orchestrator_route', 'orchestrator_user_trigger_create'],
  permission: 'read-only',
} as const satisfies RoleProfile

/** A Worker gets the work tools plus its report and Ticket-scoped coordination tools. */
export const WORKER_PROFILE = {
  name: 'worker.v1',
  prompt: 'Do the work in the Ticket. Use the work tools, report progress and the final result with control_report, and '
    + 'hand back messages that belong to another Ticket. Use control_report to interact with the control plane.',
  tools: [
    'read', 'write', 'edit', 'read_image', 'glob', 'grep', 'bash', 'pwsh', 'job_output', 'job_list', 'job_kill',
    'web_search', 'web_fetch', 'skill', 'todo_write', 'subagent', 'list_subagent_models', 'send_message', 'list_agents',
    'interrupt_agent', 'orchestrator_read', 'orchestrator_ack', 'orchestrator_thread_unrelated', 'orchestrator_thread_follow',
    'orchestrator_trigger_handback', 'orchestrator_report', 'control_report',
  ],
  deny: [
    'orchestrator_project_report',
    'orchestrator_project_ticket_create',
    'orchestrator_project_ticket_message',
    'orchestrator_project_ticket_revive',
    'orchestrator_project_ticket_handoff',
    'orchestrator_project_ticket_handoff_new_ticket',
    'orchestrator_project_ticket_handoff_to_project',
    'orchestrator_project_ticket_handoff_decide',
  ],
  permission: 'workspace-write',
} as const satisfies RoleProfile

/** A read-only investigator the PM may ask for a second look. */
export const SCOUT_PROFILE = {
  name: 'scout.v1',
  prompt: 'Inspect the workspace and report facts. Do not modify files or run commands that change state.',
  tools: ['read', 'read_image', 'glob', 'grep', 'orchestrator_read'],
  deny: ['write', 'edit', 'bash', 'pwsh', 'subagent'],
  permission: 'read-only',
} as const satisfies RoleProfile
