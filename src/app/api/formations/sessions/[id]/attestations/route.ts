import { traiterListeAttestations, traiterEmissionAttestations } from '@/formations/routes'

export const GET = async (request: Request, ctx: { params: Promise<{ id: string }> }) => traiterListeAttestations(request, (await ctx.params).id)
export const POST = async (request: Request, ctx: { params: Promise<{ id: string }> }) => traiterEmissionAttestations(request, (await ctx.params).id)
