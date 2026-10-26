import { traiterReponsesAutodiagnostic } from '@/autodiagnostic/routes'

export const PATCH = async (request: Request, ctx: { params: Promise<{ id: string }> }) => traiterReponsesAutodiagnostic(request, (await ctx.params).id)
