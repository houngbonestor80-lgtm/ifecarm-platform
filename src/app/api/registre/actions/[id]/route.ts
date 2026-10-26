import { traiterStatutAction } from '@/registre/routes'

export const PATCH = async (request: Request, ctx: { params: Promise<{ id: string }> }) => traiterStatutAction(request, (await ctx.params).id)
