import { traiterAnnulationAttestation } from '@/formations/routes'

export const PATCH = async (request: Request, ctx: { params: Promise<{ id: string }> }) => traiterAnnulationAttestation(request, (await ctx.params).id)
