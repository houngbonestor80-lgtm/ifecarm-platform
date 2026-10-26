import { traiterTerminerAutodiagnostic } from '@/autodiagnostic/routes'

export const POST = async (request: Request, ctx: { params: Promise<{ id: string }> }) => traiterTerminerAutodiagnostic(request, (await ctx.params).id)
