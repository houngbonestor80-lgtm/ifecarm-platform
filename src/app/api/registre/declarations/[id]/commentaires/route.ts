import { traiterCommentaire } from '@/registre/routes'

export const POST = async (request: Request, ctx: { params: Promise<{ id: string }> }) => traiterCommentaire(request, (await ctx.params).id)
