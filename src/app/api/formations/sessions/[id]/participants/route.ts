import { traiterAjoutParticipant } from '@/formations/routes'

export const POST = async (request: Request, ctx: { params: Promise<{ id: string }> }) => traiterAjoutParticipant(request, (await ctx.params).id)
