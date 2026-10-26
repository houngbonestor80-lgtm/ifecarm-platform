import { traiterFicheSalarie } from '@/habilitations/routes'

export const GET = async (request: Request, ctx: { params: Promise<{ id: string }> }) => traiterFicheSalarie(request, (await ctx.params).id)
