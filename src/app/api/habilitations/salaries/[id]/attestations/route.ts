import { traiterAttestationsSalarie } from '@/habilitations/routes'

export const GET = async (request: Request, ctx: { params: Promise<{ id: string }> }) => traiterAttestationsSalarie(request, (await ctx.params).id)
