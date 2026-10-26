import { traiterCreationAction } from '@/registre/routes'

export const POST = async (request: Request, ctx: { params: Promise<{ id: string }> }) => traiterCreationAction(request, (await ctx.params).id)
