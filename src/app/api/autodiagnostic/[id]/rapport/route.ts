import { traiterRapportAutodiagnostic } from '@/autodiagnostic/routes'

export const GET = async (request: Request, ctx: { params: Promise<{ id: string }> }) => traiterRapportAutodiagnostic(request, (await ctx.params).id)
