import { traiterAjoutPiece } from '@/registre/routes'

export const POST = async (request: Request, ctx: { params: Promise<{ id: string }> }) => traiterAjoutPiece(request, (await ctx.params).id)
