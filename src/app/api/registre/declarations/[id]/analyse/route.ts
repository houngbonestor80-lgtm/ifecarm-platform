import { traiterAnalyse } from '@/registre/routes'

export const PUT = async (request: Request, ctx: { params: Promise<{ id: string }> }) => traiterAnalyse(request, (await ctx.params).id)
