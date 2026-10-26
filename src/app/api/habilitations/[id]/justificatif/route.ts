import { traiterAjoutJustificatif } from '@/habilitations/routes'

export const POST = async (request: Request, ctx: { params: Promise<{ id: string }> }) => traiterAjoutJustificatif(request, (await ctx.params).id)
