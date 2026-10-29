import { traiterSuiviMiniAudit } from '@/mini-audit/routes'

export const POST = async (request: Request, ctx: { params: Promise<{ id: string }> }) => traiterSuiviMiniAudit(request, (await ctx.params).id)
