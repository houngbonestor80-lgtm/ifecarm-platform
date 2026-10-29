import { traiterConversionMiniAudit } from '@/mini-audit/routes'

export const POST = async (request: Request, ctx: { params: Promise<{ id: string }> }) => traiterConversionMiniAudit(request, (await ctx.params).id)
