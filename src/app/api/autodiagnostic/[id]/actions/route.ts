import { traiterActionsAutodiagnostic } from '@/autodiagnostic/routes'

export const POST = async (request: Request, ctx: { params: Promise<{ id: string }> }) => traiterActionsAutodiagnostic(request, (await ctx.params).id)
