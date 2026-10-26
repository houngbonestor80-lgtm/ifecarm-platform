import { traiterRenouvellement } from '@/habilitations/routes'

export const POST = async (request: Request, ctx: { params: Promise<{ id: string }> }) => traiterRenouvellement(request, (await ctx.params).id)
